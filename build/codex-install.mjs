import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, readFile, readdir, readlink, lstat, rm, rename, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { Fault } from './model.mjs';
export const CODEX_VERSION = '0.167.0';
const assets = new URL('../codex/', import.meta.url);
export function codexBinary(platform = process.platform, arch = process.arch) {
    if (!['linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch))
        throw new Fault('CODEX_PLATFORM_UNSUPPORTED');
    const target = `${arch === 'x64' ? 'x86_64' : 'aarch64'}-${platform === 'linux' ? 'unknown-linux-musl' : 'apple-darwin'}`;
    // Exact layout inspected in the pinned official npm launcher. Run its native binary directly, without a wrapper process.
    return join('node_modules', '@openai', `codex-${platform}-${arch}`, 'vendor', target, 'bin', 'codex');
}
const cancelled = () => new Fault('CANCELLED', 499);
const check = (signal) => { if (signal.aborted)
    throw cancelled(); };
// POSIX process groups include npm's children. Diagnostics are deliberately not surfaced.
export function installProcess(command, args, cwd, env, signal) {
    check(signal);
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', size = 0, failure, kill;
        const terminate = (error) => {
            failure ??= error;
            const stop = (sig) => { try {
                if (child.pid)
                    process.kill(-child.pid, sig);
            }
            catch { /* Already exited. */ } };
            stop('SIGTERM');
            kill ??= setTimeout(() => stop('SIGKILL'), 500);
        };
        const abort = () => terminate(cancelled());
        signal.addEventListener('abort', abort, { once: true });
        child.once('error', () => { failure ??= new Fault('CODEX_INSTALLER_UNAVAILABLE'); });
        child.stdout.on('data', (chunk) => {
            size += chunk.length;
            if (size > 65536)
                terminate(new Fault('CODEX_INSTALL_OUTPUT_LIMIT'));
            else
                output += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            size += chunk.length;
            if (size > 65536)
                terminate(new Fault('CODEX_INSTALL_OUTPUT_LIMIT'));
        });
        child.once('close', code => {
            clearTimeout(kill);
            signal.removeEventListener('abort', abort);
            if (child.pid) {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                }
                catch { /* Group already exited. */ }
            }
            if (failure || code !== 0)
                reject(failure ?? new Fault('CODEX_INSTALL_FAILED'));
            else
                resolve(output.trim());
        });
        if (signal.aborted)
            abort();
    });
}
// Detect accidental corruption (including executable modes/symlink targets) before cache reuse.
// This private marker is not protection against malicious code running as the same OS user.
async function treeDigest(root, signal) {
    const hash = createHash('sha256');
    const visit = async (relative) => {
        for (const name of (await readdir(join(root, relative))).sort()) {
            if (!relative && name === 'ready.json')
                continue;
            check(signal);
            const path = join(relative, name), file = join(root, path), info = await lstat(file);
            hash.update(JSON.stringify([path, info.mode, info.size]));
            if (info.isDirectory())
                await visit(path);
            else if (info.isSymbolicLink())
                hash.update(await readlink(file));
            else if (info.isFile())
                for await (const chunk of createReadStream(file)) {
                    check(signal);
                    hash.update(chunk);
                }
            else
                throw new Fault('CODEX_INSTALL_INVALID');
        }
    };
    await visit('');
    return hash.digest('hex');
}
// The caller must hold Store's exclusive data-directory lock for this manager's lifetime.
export class CodexInstallation {
    root;
    npm;
    timeoutMs;
    stopped = false;
    ready;
    flight;
    constructor(root, npm = 'npm', timeoutMs = 180000) {
        this.root = root;
        this.npm = npm;
        this.timeoutMs = timeoutMs;
    }
    async prepare(signal) {
        check(signal);
        if (this.stopped)
            throw cancelled();
        if (this.ready)
            return this.ready;
        if (!this.flight) {
            const abort = new AbortController();
            const work = this.install(AbortSignal.any([abort.signal, AbortSignal.timeout(this.timeoutMs)]));
            const flight = this.flight = { work, abort, waiters: 0 };
            work.then(command => { this.ready = command; }, () => { }).finally(() => { if (this.flight === flight)
                this.flight = undefined; });
        }
        const flight = this.flight;
        flight.waiters++;
        try {
            return await new Promise((resolve, reject) => {
                const abort = () => reject(cancelled());
                signal.addEventListener('abort', abort, { once: true });
                flight.work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
                if (signal.aborted)
                    abort();
            });
        }
        finally {
            if (--flight.waiters === 0 && !this.ready)
                flight.abort.abort();
        }
    }
    async install(signal) {
        if (Number(process.versions.node.split('.')[0]) < 24)
            throw new Fault('CODEX_NODE_REQUIRED');
        const binary = codexBinary();
        const pkg = await readFile(new URL('package.json', assets)), lock = await readFile(new URL('package-lock.json', assets));
        const pin = createHash('sha256').update(pkg).update(lock).update(binary).digest('hex');
        const current = join(this.root, 'current'), stage = join(this.root, 'staging'), home = join(this.root, 'home');
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        await chmod(this.root, 0o700);
        await mkdir(home, { recursive: true, mode: 0o700 });
        await mkdir(join(home, 'tmp'), { recursive: true, mode: 0o700 });
        const env = { PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? '/usr/bin:/bin'), HOME: home, CODEX_HOME: home,
            TMPDIR: join(home, 'tmp'), LANG: 'C.UTF-8', npm_config_cache: join(this.root, 'cache'),
            npm_config_userconfig: join(home, 'npmrc'), npm_config_globalconfig: join(home, 'global-npmrc') };
        await writeFile(env.npm_config_userconfig, '', { mode: 0o600 });
        await writeFile(env.npm_config_globalconfig, '', { mode: 0o600 });
        await rm(stage, { recursive: true, force: true });
        try {
            const marker = JSON.parse(await readFile(join(current, 'ready.json'), 'utf8'));
            if (marker.pin === pin && marker.digest === await treeDigest(current, signal)
                && await installProcess(join(current, binary), ['--version'], home, env, AbortSignal.any([signal, AbortSignal.timeout(10000)])) === `codex-cli ${CODEX_VERSION}`)
                return join(current, binary);
        }
        catch {
            check(signal);
        }
        await rm(current, { recursive: true, force: true });
        try {
            const npmVersion = await installProcess(this.npm, ['--version'], home, env, AbortSignal.any([signal, AbortSignal.timeout(10000)]));
            if (!/^\d+\.\d+\.\d+$/.test(npmVersion) || Number(npmVersion.split('.')[0]) < 10)
                throw new Fault('CODEX_NPM_REQUIRED');
            await mkdir(stage, { mode: 0o700 });
            await writeFile(join(stage, 'package.json'), pkg, { mode: 0o600 });
            await writeFile(join(stage, 'package-lock.json'), lock, { mode: 0o600 });
            await installProcess(this.npm, ['ci', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund', '--loglevel=error',
                '--registry=https://registry.npmjs.org', '--fetch-retries=1', '--fetch-timeout=60000'], stage, env, signal);
            if (await installProcess(join(stage, binary), ['--version'], home, env, AbortSignal.any([signal, AbortSignal.timeout(10000)])) !== `codex-cli ${CODEX_VERSION}`)
                throw new Fault('CODEX_VERSION_MISMATCH');
            const digest = await treeDigest(stage, signal);
            await writeFile(join(stage, 'ready.json'), JSON.stringify({ pin, digest }), { mode: 0o600 });
            check(signal);
            await rename(stage, current);
            return join(current, binary);
        }
        catch (error) {
            await rm(stage, { recursive: true, force: true });
            throw signal.aborted ? (signal.reason?.name === 'TimeoutError' ? new Fault('CODEX_INSTALL_TIMEOUT') : cancelled()) : error instanceof Fault ? error : new Fault('CODEX_INSTALL_FAILED');
        }
    }
    async close() {
        this.stopped = true;
        this.flight?.abort.abort();
        await this.flight?.work.catch(() => { });
    }
}
