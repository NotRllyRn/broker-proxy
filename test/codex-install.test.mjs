import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexInstallation, CODEX_VERSION, codexBinary } from '../build/codex-install.mjs';
import { CodexProvider, ProviderAdmissionFault } from '../build/provider.mjs';
import { Broker } from '../build/broker.mjs';
import { Store } from '../build/store.mjs';
import { temp, until, auth, fixtureCommand } from './helpers.mjs';

async function fixture(t, mode = 'success', timeout = 5000) {
  const dir = await temp(), root = join(dir, 'codex'), state = join(dir, 'mode'), calls = join(dir, 'calls'), npm = join(dir, 'npm');
  await writeFile(state, mode);
  await writeFile(npm, `#!${process.execPath}
import { readFileSync, writeFileSync, mkdirSync, chmodSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
const mode = readFileSync(${JSON.stringify(state)}, 'utf8');
if (process.argv[2] === '--version') { console.log(mode === 'old-npm' ? '9.0.0' : '11.13.0'); process.exit(); }
appendFileSync(${JSON.stringify(calls)}, 'install\\n');
const pkg = JSON.parse(readFileSync('package.json')), lock = JSON.parse(readFileSync('package-lock.json'));
if (pkg.dependencies['@openai/codex'] !== '${CODEX_VERSION}' || lock.packages['node_modules/@openai/codex'].version !== '${CODEX_VERSION}'
 || !['ci','--ignore-scripts','--include=optional','--registry=https://registry.npmjs.org'].every(a => process.argv.includes(a))) process.exit(2);
if (mode === 'fail') { console.error('private npm diagnostics'); process.exit(1); }
if (mode === 'noisy') { process.stderr.write('x'.repeat(65537)); await new Promise(r => setTimeout(r, 1000)); }
if (mode === 'hang') {
 const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {stdio:'ignore'});
 writeFileSync(${JSON.stringify(join(dir, 'child'))}, String(child.pid));
 process.on('SIGTERM', () => {}); await new Promise(() => {});
}
if (mode === 'slow') await new Promise(r => setTimeout(r, 250));
if (mode !== 'missing') {
 const path = join(process.cwd(), ${JSON.stringify(codexBinary())});
 mkdirSync(dirname(path), {recursive:true});
 writeFileSync(path, '#!${process.execPath}\\nconsole.log("codex-cli ' + (mode === 'wrong-version' ? '0.0.0' : '${CODEX_VERSION}') + '")\\n'); chmodSync(path, 0o755);
}
`, { mode: 0o700 });
  // .mjs is not needed: the temporary root has an explicit module boundary.
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  const manager = new CodexInstallation(root, npm, timeout);
  t.after(async () => { await manager.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, root, npm, state, calls, manager, count: async () => (await readFile(calls, 'utf8')).trim().split('\n').length };
}
const signal = () => AbortSignal.timeout(10000);

test('committed official lock pins wrapper and all six native artifacts with SHA-512 integrity', async () => {
  const pkg = JSON.parse(await readFile(new URL('../codex/package.json', import.meta.url)));
  const lock = JSON.parse(await readFile(new URL('../codex/package-lock.json', import.meta.url)));
  assert.equal(pkg.dependencies['@openai/codex'], CODEX_VERSION); assert.equal(lock.lockfileVersion, 3);
  assert.equal(Object.keys(lock.packages).length, 8);
  for (const [path, p] of Object.entries(lock.packages)) if (path) {
    assert.match(p.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(p.resolved, `https://registry.npmjs.org/@openai/codex/-/codex-${p.version}.tgz`);
    assert.ok(p.version === CODEX_VERSION || p.version.startsWith(CODEX_VERSION + '-'));
  }
  assert.match(codexBinary('linux', 'arm64'), /aarch64-unknown-linux-musl/);
  assert.match(codexBinary('darwin', 'x64'), /x86_64-apple-darwin/);
  assert.throws(() => codexBinary('win32', 'x64'), /CODEX_PLATFORM_UNSUPPORTED/);
});

test('exact install is single-flight, private, atomically published, and reused without npm', async t => {
  const f = await fixture(t, 'slow');
  const commands = await Promise.all(Array.from({ length: 8 }, () => f.manager.prepare(signal())));
  assert.ok(commands.every(c => c === join(f.root, 'current', codexBinary())));
  assert.equal(await f.count(), 1); assert.equal((await stat(f.root)).mode & 0o777, 0o700);
  await assert.rejects(access(join(f.root, 'staging')));
  await f.manager.close();
  const reopened = new CodexInstallation(f.root, '/does/not/exist');
  try { assert.equal(await reopened.prepare(signal()), commands[0]); } finally { await reopened.close(); }
});

for (const damage of ['contents', 'mode', 'marker', 'partial']) test(`cache recovery: ${damage}`, async t => {
  const f = await fixture(t), command = await f.manager.prepare(signal()); await f.manager.close();
  if (damage === 'contents') await writeFile(command, 'corrupt');
  if (damage === 'mode') await chmod(command, 0o644);
  if (damage === 'marker') await writeFile(join(f.root, 'current', 'ready.json'), '{}');
  if (damage === 'partial') await rm(join(f.root, 'current', 'ready.json'));
  await mkdir(join(f.root, 'staging'), { recursive: true }); await writeFile(join(f.root, 'staging', 'abandoned'), 'partial');
  const reopened = new CodexInstallation(f.root, f.npm);
  try { await reopened.prepare(signal()); assert.equal(await f.count(), 2); await assert.rejects(access(join(f.root, 'staging'))); }
  finally { await reopened.close(); }
});

for (const [mode, error] of [['fail', 'CODEX_INSTALL_FAILED'], ['noisy', 'CODEX_INSTALL_OUTPUT_LIMIT'], ['wrong-version', 'CODEX_VERSION_MISMATCH'], ['missing', 'CODEX_INSTALLER_UNAVAILABLE'], ['old-npm', 'CODEX_NPM_REQUIRED']]) test(`failed install is not published and can retry: ${mode}`, async t => {
  const f = await fixture(t, mode);
  await assert.rejects(f.manager.prepare(signal()), e => e.message === error);
  await assert.rejects(access(join(f.root, 'current'))); await assert.rejects(access(join(f.root, 'staging')));
  await writeFile(f.state, 'success'); await f.manager.prepare(signal());
});

test('missing npm is explicit; never falls back to global Codex', async t => {
  const f = await fixture(t), manager = new CodexInstallation(f.root, '/missing-npm');
  try { await assert.rejects(manager.prepare(signal()), /CODEX_INSTALLER_UNAVAILABLE/); }
  finally { await manager.close(); }
  await assert.rejects(access(f.calls));
});

test('one cancelled waiter does not cancel another install waiter', async t => {
  const f = await fixture(t, 'slow'), abort = new AbortController();
  const cancelled = f.manager.prepare(abort.signal), survivor = f.manager.prepare(signal());
  abort.abort(); await assert.rejects(cancelled, /CANCELLED/); await survivor; assert.equal(await f.count(), 1);
});

for (const action of ['cancel', 'close', 'timeout']) test(`installation ${action} reaps an uncooperative subprocess group and removes staging`, { timeout: 10000 }, async t => {
  const f = await fixture(t, 'hang', action === 'timeout' ? 1200 : 5000), abort = new AbortController();
  const work = f.manager.prepare(abort.signal); work.catch(() => {});
  await until(async () => { try { await access(join(f.dir, 'child')); return true; } catch { return false; } });
  const pid = Number(await readFile(join(f.dir, 'child'), 'utf8'));
  if (action === 'cancel') abort.abort();
  if (action === 'close') await f.manager.close();
  await assert.rejects(work, new RegExp(action === 'timeout' ? 'CODEX_INSTALL_TIMEOUT' : 'CANCELLED'));
  await f.manager.close(); await assert.rejects(access(join(f.root, 'staging')));
  // A killed orphan may briefly remain a zombie until the container's init reaps it.
  await until(async () => {
    try { process.kill(pid, 0); return process.platform === 'linux' && (await readFile(`/proc/${pid}/stat`, 'utf8')).split(' ')[2] === 'Z'; }
    catch { return true; }
  });
  await assert.rejects(f.manager.prepare(signal()), /CANCELLED/);
});

test('provider shutdown cancels background preparation and waiting refresh without persisting quarantine', async t => {
  const f = await fixture(t, 'hang'), dataDir = await temp(), provider = new CodexProvider(join(dataDir, 'runtimes'));
  provider.installation = f.manager; // Fixture npm, not a real download; exercise actual provider lifecycle.
  const broker = new Broker(await Store.open(dataDir), provider, []);
  t.after(async () => { await broker.close(); await rm(dataDir, { recursive: true, force: true }); });
  const id = await broker.importAccount('Example user', [], auth('a'));
  const background = provider.prepare(), refresh = broker.refresh(id);
  background.catch(() => {}); refresh.catch(() => {});
  await until(async () => { try { await access(join(f.dir, 'child')); return true; } catch { return false; } });
  assert.equal(broker.view().accounts[0].authState, 'verified');
  await broker.close();
  await assert.rejects(background, /CANCELLED/); await assert.rejects(refresh, /CANCELLED/);
  assert.equal(JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')).accounts[0].authState, 'verified');
  await assert.rejects(access(join(f.root, 'staging')));
});

test('explicit provider override bypasses installation entirely', async t => {
  const dir = await temp(), provider = new CodexProvider(join(dir, 'runtimes'), await fixtureCommand(dir));
  t.after(async () => { await provider.close(); await rm(dir, { recursive: true, force: true }); });
  await provider.prepare(); await provider.login(signal(), () => {});
  await assert.rejects(access(join(dir, 'codex')));
});

test('installer/admission errors preserve healthy credentials; real runtime failures still quarantine', async t => {
  const f = await fixture(t, 'fail'), dataDir = await temp(), provider = new CodexProvider(join(dataDir, 'runtimes'));
  // Keep this fixture test offline while exercising the real provider preparation/admission boundary.
  provider.prepare = signal => f.manager.prepare(signal);
  const broker = new Broker(await Store.open(dataDir), provider, []);
  t.after(async () => { await broker.close(); await rm(dataDir, { recursive: true, force: true }); });
  const id = await broker.importAccount('Example user', [], auth('a'));
  await assert.rejects(broker.refresh(id), /CODEX_INSTALL_FAILED/);
  assert.equal(broker.view().accounts[0].authState, 'verified');
  assert.equal(broker.view().accounts[0].lastError, null);
  // Also cover an admission failure after the broker's preflight but before runtime creation.
  let calls = 0; provider.prepare = signal => ++calls === 1 ? Promise.resolve('unused') : f.manager.prepare(signal);
  await assert.rejects(broker.refresh(id), e => e instanceof ProviderAdmissionFault && e.code === 'CODEX_INSTALL_FAILED');
  assert.equal(broker.view().accounts[0].authState, 'verified');
  assert.equal(broker.view().accounts[0].lastError, 'CODEX_INSTALL_FAILED');
  await assert.rejects(access(join(dataDir, 'runtimes')));
  provider.prepare = async () => '/missing-explicit-codex';
  await assert.rejects(broker.refresh(id), e => e instanceof ProviderAdmissionFault);
  assert.equal(broker.view().accounts[0].authState, 'verified');
  provider.prepare = async () => await fixtureCommand(f.dir, 'refresh-failure');
  await assert.rejects(broker.refresh(id), /PROVIDER_RPC_FAILED/);
  assert.equal(broker.view().accounts[0].authState, 'required');
});
