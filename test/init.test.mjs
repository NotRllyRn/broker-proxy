import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, readdir, stat, chmod, chown, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { temp } from './helpers.mjs';
import { initialize } from '../build/initialize.mjs';
import setup from '../build/extension.mjs';
import { Store } from '../build/store.mjs';
const exec = promisify(execFile);
const init = dir => exec(process.execPath, ['scripts/init.mjs', dir]);

for (const precreated of [false, true]) test(`init accepts ${precreated ? 'host-created empty' : 'new external'} private directory without exposing secrets`, async t => {
  const root = await temp(), dir = join(root, 'broker-proxy');
  t.after(() => rm(root, { recursive: true, force: true }));
  if (precreated) await mkdir(dir, { mode: 0o700 });
  const { stdout, stderr } = await init(dir);
  const secrets = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8'));
  for (const secret of Object.values(secrets)) assert.ok(!(stdout + stderr).includes(secret));
  const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  assert.equal(config.dataDir, join(dir, 'data'));
  const state = JSON.parse(await readFile(join(config.dataDir, 'state.json'), 'utf8'));
  assert.equal(state.accounts.length, 0); assert.equal(state.callers.length, 1);
  assert.deepEqual(await readdir(config.dataDir), ['state.json']); // No provider runtime/install or lock.
  for (const [path, mode] of [[dir, 0o700], [config.dataDir, 0o700], [join(dir, 'config.json'), 0o600], [join(dir, 'secrets.json'), 0o600], [join(config.dataDir, 'state.json'), 0o600]]) {
    const info = await stat(path); assert.equal(info.mode & 0o7777, mode); assert.equal(info.uid, process.getuid());
  }
  const before = await readFile(join(config.dataDir, 'state.json'));
  await assert.rejects(init(dir), /INIT_DIRECTORY_NOT_EMPTY/);
  assert.deepEqual(await readFile(join(config.dataDir, 'state.json')), before);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8')), secrets);
});

test('init refuses existing contents, unsafe permissions, symlinks and non-directories without repair', async t => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['config.json', 'secrets.json', 'state.json', 'lock', 'data', '.unexpected']) {
    const dir = join(root, name + '-case'); await mkdir(dir, { mode: 0o700 });
    const path = join(dir, name); await writeFile(path, 'preserve', { mode: 0o600 });
    await assert.rejects(init(dir), /INIT_DIRECTORY_NOT_EMPTY/);
    assert.deepEqual(await readdir(dir), [name]); assert.equal(await readFile(path, 'utf8'), 'preserve');
  }
  const unsafe = join(root, 'unsafe'); await mkdir(unsafe, { mode: 0o700 });
  for (const mode of [0o755, 0o750, 0o1700]) {
    await chmod(unsafe, mode); await assert.rejects(init(unsafe), /UNSAFE_INIT_DIRECTORY/);
    assert.equal((await stat(unsafe)).mode & 0o7777, mode); assert.deepEqual(await readdir(unsafe), []);
  }
  await chmod(unsafe, 0o700);
  const link = join(root, 'link'); await symlink(unsafe, link);
  await assert.rejects(init(link), /UNSAFE_INIT_DIRECTORY/);
  await assert.rejects(init(join(link, 'child')), /UNSAFE_INIT_DIRECTORY/);
  assert.deepEqual(await readdir(unsafe), []);
  const file = join(root, 'file'); await writeFile(file, 'preserve');
  await assert.rejects(init(file), /UNSAFE_INIT_DIRECTORY/); assert.equal(await readFile(file, 'utf8'), 'preserve');
  await assert.rejects(init('relative'), /Usage:/);
});

test('init refuses wrong ownership without repair', { skip: process.getuid?.() !== 0 && 'requires chown capability' }, async t => {
  const root = await temp(), dir = join(root, 'other-owner');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(dir, { mode: 0o700 }); await chown(dir, 65534, 65534);
  await assert.rejects(init(dir), /UNSAFE_INIT_DIRECTORY/);
  assert.equal((await stat(dir)).uid, 65534); assert.deepEqual(await readdir(dir), []);
});

test('default initializer reuses complete files without rotating credentials or resetting state', async t => {
  const dir = await temp(); t.after(() => rm(dir, { recursive: true, force: true }));
  const config = await initialize(dir, true);
  const paths = ['config.json', 'secrets.json', 'data/state.json'];
  const before = await Promise.all(paths.map(p => readFile(join(dir, p))));
  assert.deepEqual(await initialize(dir, true), config);
  assert.deepEqual(await Promise.all(paths.map(p => readFile(join(dir, p)))), before);
  assert.deepEqual((await readdir(dir)).sort(), ['config.json', 'data', 'secrets.json']);
});

test('partial or unsafe default initialization fails closed without clobber or repair', async t => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['.initializing', 'secrets.json', 'data', 'unexpected']) {
    const dir = join(root, name + '-partial'); await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, name), 'preserve', { mode: 0o600 });
    await assert.rejects(initialize(dir, true), /BROKER_INIT_IN_(PROGRESS_OR_INCOMPLETE)|BROKER_INIT_INCOMPLETE/);
    assert.deepEqual(await readdir(dir), [name]); assert.equal(await readFile(join(dir, name), 'utf8'), 'preserve');
  }
  for (const path of ['config.json', 'secrets.json', 'data/state.json']) {
    const dir = join(root, path.replaceAll('/', '-') + '-unsafe'); await mkdir(dir, { mode: 0o700 });
    await initialize(dir, true);
    const file = join(dir, path), before = await readFile(file);
    await chmod(file, 0o644); await assert.rejects(initialize(dir, true), /UNSAFE_INIT_FILE/);
    assert.deepEqual(await readFile(file), before); assert.equal((await stat(file)).mode & 0o777, 0o644);
    await rm(file); await assert.rejects(initialize(dir, true), /BROKER_INIT_INCOMPLETE/);
    await writeFile(file + '.original', before, { mode: 0o600 }); await symlink(file + '.original', file);
    await assert.rejects(initialize(dir, true), /UNSAFE_INIT_FILE/);
  }
  const malformed = join(root, 'malformed'); await mkdir(malformed, { mode: 0o700 }); await initialize(malformed, true);
  await writeFile(join(malformed, 'secrets.json'), 'private-invalid-secret', { mode: 0o600 });
  await assert.rejects(initialize(malformed, true), e => { assert.equal(e.message, 'BROKER_INIT_INCOMPLETE'); return true; });
});

test('concurrent standalone initialization has exactly one owner and never overwrites its secrets', async t => {
  const dir = await temp(); t.after(() => rm(dir, { recursive: true, force: true }));
  const results = await Promise.allSettled([init(dir), init(dir)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /INIT_DIRECTORY_NOT_EMPTY|BROKER_INIT_IN_PROGRESS_OR_INCOMPLETE/);
  await initialize(dir, true);
});

test('failed initialization retains its marker and files, requiring explicit recovery', async t => {
  const dir = await temp(), original = Store.open;
  t.after(() => rm(dir, { recursive: true, force: true }));
  Store.open = async () => { throw new Error('injected state write failure'); };
  try { await assert.rejects(initialize(dir, true), /injected state write failure/); }
  finally { Store.open = original; }
  assert.deepEqual((await readdir(dir)).sort(), ['.initializing', 'data', 'secrets.json']);
  const secrets = await readFile(join(dir, 'secrets.json'));
  await assert.rejects(initialize(dir, true), /BROKER_INIT_IN_PROGRESS_OR_INCOMPLETE/);
  assert.deepEqual(await readFile(join(dir, 'secrets.json')), secrets);
});

test('setup explicit missing override never initializes host storage or acquires resources', async t => {
  const dir = await temp(), previous = process.env.BROKER_CONFIG;
  t.after(async () => {
    if (previous === undefined) delete process.env.BROKER_CONFIG; else process.env.BROKER_CONFIG = previous;
    await rm(dir, { recursive: true, force: true });
  });
  process.env.BROKER_CONFIG = join(dir, 'missing.json');
  const unexpected = () => assert.fail('no resource registration before valid configuration');
  await assert.rejects(setup({ dataDir: dir, on: unexpected, cleanup: unexpected, log: unexpected }), /BROKER_CONFIG_NOT_INITIALIZED/);
  assert.deepEqual(await readdir(dir), []);
  delete process.env.BROKER_CONFIG;
  await assert.rejects(setup({ on: unexpected, cleanup: unexpected, log: unexpected }), /HOST_DATA_DIR_REQUIRED/);
});
