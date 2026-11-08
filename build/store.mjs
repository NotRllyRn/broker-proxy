import { mkdir, readFile, open, rename, unlink, chmod, lstat, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyState, Fault, object, credential, labels, text } from './model.mjs';
import { defaultSettings, emptyPulse, settings, windows } from './scheduler.mjs';
export const STATE_LIMIT = 32 * 1024 * 1024;
function validate(value) {
    const s = object(value);
    if (s.version !== 1 || !Array.isArray(s.accounts) || !Array.isArray(s.callers) || !Array.isArray(s.exclusions) || !Array.isArray(s.history)
        || s.accounts.length > 1000 || s.callers.length > 1000 || s.history.length > 200)
        throw new Fault('INVALID_STATE');
    const state = s;
    state.pulseSettings = settings(state.pulseSettings ?? defaultSettings());
    state.scheduler ??= { nextAt: 0, nextRegularAt: 0, cursor: 0 };
    const nonnegative = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
    if (!['nextAt', 'nextRegularAt', 'cursor'].every(k => nonnegative(object(state.scheduler)[k])))
        throw new Fault('INVALID_STATE');
    const ids = new Set();
    for (const a of state.accounts) {
        text(a.id);
        text(a.label);
        labels(a.labels);
        a.generation ??= randomUUID(); // Additive migration of the initial version-1 format.
        text(a.generation);
        if (ids.has(a.id) || typeof a.enabled !== 'boolean' || !['verified', 'refreshing', 'required'].includes(a.authState)
            || !Number.isFinite(a.createdAt) || !a.credential || typeof a.identity !== 'string')
            throw new Fault('INVALID_STATE');
        ids.add(a.id);
        const p = a.pulse ??= emptyPulse();
        if (typeof p.initialized !== 'boolean' || typeof p.needsConfirmation !== 'boolean' || !nonnegative(p.nextAttemptAt) || !nonnegative(p.failures) || p.failures > 5)
            throw new Fault('INVALID_STATE');
        for (const k of windows)
            for (const targets of [p.targets, p.handled])
                if (!targets || targets[k] !== null && !nonnegative(targets[k]))
                    throw new Fault('INVALID_STATE');
        if (p.last && (!nonnegative(p.last.at) || p.last.finishedAt !== undefined && !nonnegative(p.last.finishedAt)
            || typeof p.last.automatic !== 'boolean' || !['preparing', 'running', 'completed', 'failed', 'uncertain', 'skipped'].includes(p.last.status)))
            throw new Fault('INVALID_STATE');
        if (p.last?.code)
            text(p.last.code, 120);
        if (p.last?.model)
            text(p.last.model, 200);
        if (a.usageStatus && (!nonnegative(a.usageStatus.at) || !['complete', 'incomplete', 'failed'].includes(a.usageStatus.status)))
            throw new Fault('INVALID_STATE');
        if (a.stats && !['selected', 'responses', 'errors'].every(k => nonnegative(object(a.stats)[k])))
            throw new Fault('INVALID_STATE');
        const c = credential(a.credential.auth, 0);
        if (c.accessToken !== a.credential.accessToken || c.accountId !== a.credential.accountId || c.expiresAt !== a.credential.expiresAt)
            throw new Fault('INVALID_STATE');
        if (a.quota)
            for (const w of [a.quota.short, a.quota.weekly]) {
                if (!w || !Number.isFinite(w.used) || w.used < 0 || w.used > 100 || w.reset !== null && !Number.isFinite(w.reset))
                    throw new Fault('INVALID_STATE');
            }
        if (a.blockedAt !== null && !Number.isFinite(a.blockedAt))
            throw new Fault('INVALID_STATE');
    }
    ids.clear();
    for (const c of state.callers) {
        text(c.id);
        text(c.label);
        labels(c.allow);
        labels(c.block);
        if (ids.has(c.id) || !/^[a-f0-9]{64}$/.test(c.digest) || typeof c.enabled !== 'boolean')
            throw new Fault('INVALID_STATE');
        ids.add(c.id);
    }
    for (const n of Object.values(object(state.counters)))
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0)
            throw new Fault('INVALID_STATE');
    for (const e of state.exclusions)
        if (!Number.isFinite(e.until) || typeof e.caller !== 'string' || typeof e.account !== 'string')
            throw new Fault('INVALID_STATE');
    return state;
}
export class Store {
    dir;
    lock;
    state = emptyState();
    tail = Promise.resolve();
    poisoned = false;
    closed = false;
    constructor(dir, lock) {
        this.dir = dir;
        this.lock = lock;
    }
    static async open(dir) {
        dir = resolve(dir);
        const first = await mkdir(dir, { recursive: true, mode: 0o700 });
        if (first) {
            for (let path = dir;; path = dirname(path)) {
                const parent = await open(dirname(path), 'r');
                try {
                    await parent.sync();
                }
                finally {
                    await parent.close();
                }
                if (path === first || path === dirname(path))
                    break;
            }
        }
        if ((await lstat(dir)).isSymbolicLink())
            throw new Fault('UNSAFE_STATE_DIRECTORY');
        await chmod(dir, 0o700);
        // Explicit stale-lock recovery is safer than PID reuse guesses.
        const lock = await open(join(dir, 'lock'), 'wx', 0o600).catch(() => { throw new Fault('STATE_LOCKED'); });
        const store = new Store(dir, lock);
        try {
            await lock.writeFile(String(process.pid));
            try {
                const path = join(dir, 'state.json');
                const info = await lstat(path);
                if (!info.isFile() || info.isSymbolicLink() || info.size > STATE_LIMIT)
                    throw new Fault('INVALID_STATE');
                await chmod(path, 0o600);
                store.state = validate(JSON.parse(await readFile(path, 'utf8')));
            }
            catch (e) {
                if (e.code !== 'ENOENT')
                    throw new Fault('INVALID_STATE');
            }
            await store.change(s => {
                for (const a of s.accounts) {
                    if (a.authState === 'refreshing') {
                        a.authState = 'required';
                        a.lastError = 'INTERRUPTED_REFRESH';
                    }
                    if (a.pulse?.last && ['preparing', 'running'].includes(a.pulse.last.status)) {
                        // Never replay a potentially dispatched pulse after a crash, even after reauthorization.
                        a.pulse.last.status = 'uncertain';
                        a.pulse.last.code = 'INTERRUPTED_PULSE';
                        a.pulse.needsConfirmation = true;
                    }
                }
            });
            // This directory is exclusively extension-owned; never point it at an existing Codex home.
            await rm(join(dir, 'runtimes'), { recursive: true, force: true });
            return store;
        }
        catch (e) {
            await store.close();
            throw e;
        }
    }
    snapshot() {
        if (this.poisoned || this.closed)
            throw new Fault('STORE_UNAVAILABLE');
        return structuredClone(this.state);
    }
    change(fn) {
        const run = this.tail.then(async () => {
            if (this.poisoned || this.closed)
                throw new Fault('STORE_UNAVAILABLE');
            const next = structuredClone(this.state), result = fn(next);
            const serialized = JSON.stringify(next);
            if (Buffer.byteLength(serialized) > STATE_LIMIT)
                throw new Fault('STATE_TOO_LARGE', 409);
            const path = join(this.dir, 'state.next');
            try {
                const file = await open(path, 'w', 0o600);
                try {
                    await file.writeFile(serialized);
                    await file.sync();
                }
                finally {
                    await file.close();
                }
                await rename(path, join(this.dir, 'state.json'));
                const directory = await open(this.dir, 'r');
                try {
                    await directory.sync();
                }
                finally {
                    await directory.close();
                }
            }
            catch {
                this.poisoned = true;
                throw new Fault('PERSISTENCE_FAILED');
            }
            this.state = next;
            return result;
        });
        this.tail = run.catch(() => { });
        return run;
    }
    async close() {
        await this.tail;
        if (this.closed)
            return;
        this.closed = true;
        await this.lock.close();
        await unlink(join(this.dir, 'lock'));
    }
}
