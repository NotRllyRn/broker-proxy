import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../build/config.mjs';
import { digest } from '../build/model.mjs';
import { temp } from './helpers.mjs';
test('configuration validates private files, distinct ports, origins, limits and upstream', async t => {
  const dir = await temp(), path = join(dir, 'config.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = { dataDir: join(dir, 'data'), adminHash: digest('fixture-admin') };
  const save = v => writeFile(path, JSON.stringify({ ...base, ...v }), { mode: 0o600 });
  await save({}); assert.equal((await loadConfig(path)).dashboard.port, 8788);
  assert.equal((await loadConfig(path)).codexCommand, undefined);
  await save({ codexCommand: '/deliberate/operator/codex' }); assert.equal((await loadConfig(path)).codexCommand, '/deliberate/operator/codex');
  await chmod(path, 0o644); await assert.rejects(loadConfig(path), /CONFIG_MUST_BE_PRIVATE/); await chmod(path, 0o600);
  for (const [value, error] of [
    [{ dashboard: { port: 8789 } }, /SEPARATE_PORTS_REQUIRED/],
    [{ enrollment: { host: '0.0.0.0' } }, /INVALID_ORIGIN/],
    [{ upstream: 'http://example.invalid' }, /UNSAFE_UPSTREAM/],
    [{ upstream: 'https://user:password@example.invalid' }, /UNSAFE_UPSTREAM/],
    [{ pollMs: 1 }, /INVALID_POLL_INTERVAL/],
    [{ dataDir: 'relative' }, /ABSOLUTE_DATA_DIR_REQUIRED/],
    [{ adminHash: 'invalid' }, /ADMIN_HASH_REQUIRED/],
    [{ codexCommand: null }, /INVALID_TEXT/],
    [{ codexCommand: '' }, /INVALID_TEXT/],
  ]) { await save(value); await assert.rejects(loadConfig(path), error); }
  const lan = { host: '0.0.0.0', origin: 'http://10.17.11.4:8788' };
  for (const allowInsecureHttp of [undefined, false, 'true']) {
    await save({ dashboard: lan, allowInsecureHttp });
    await assert.rejects(loadConfig(path), /INVALID_ORIGIN/);
  }
  await save({ dashboard: lan, allowInsecureHttp: true });
  assert.equal((await loadConfig(path)).dashboard.origin, lan.origin);
  await save({ dashboard: { ...lan, origin: 'http://user:password@10.17.11.4:8788' }, allowInsecureHttp: true });
  await assert.rejects(loadConfig(path), /INVALID_ORIGIN/);
  await save({ enrollment: { host: '0.0.0.0', origin: 'https://enroll.example.invalid' }, pollMs: 0 });
  assert.equal((await loadConfig(path)).enrollment.origin, 'https://enroll.example.invalid');
});

test('host config default, explicit legacy precedence and no CWD or invalid-override fallback', async t => {
  const dir = await temp(), path = join(dir, 'config.json'), legacy = join(dir, 'legacy.json');
  const previous = process.env.BROKER_CONFIG; delete process.env.BROKER_CONFIG;
  t.after(async () => {
    if (previous === undefined) delete process.env.BROKER_CONFIG; else process.env.BROKER_CONFIG = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await assert.rejects(loadConfig(), /HOST_DATA_DIR_REQUIRED/);
  await assert.rejects(loadConfig(undefined, 'relative'), /HOST_DATA_DIR_REQUIRED/);
  await assert.rejects(loadConfig(undefined, dir), /BROKER_CONFIG_NOT_INITIALIZED/);
  const base = { adminHash: digest('fixture-admin'), dataDir: join(dir, 'data') };
  await writeFile(path, JSON.stringify(base), { mode: 0o600 });
  assert.equal((await loadConfig(undefined, dir)).dataDir, base.dataDir);
  const external = join(dir, 'external-state');
  await writeFile(legacy, JSON.stringify({ ...base, dataDir: external }), { mode: 0o600 });
  process.env.BROKER_CONFIG = legacy;
  assert.equal((await loadConfig(undefined, dir)).dataDir, external);
  assert.equal((await loadConfig()).dataDir, external); // Older hosts still work with explicit config.
  assert.equal((await loadConfig(path, dir)).dataDir, base.dataDir);
  for (const invalid of ['', 'relative']) await assert.rejects(loadConfig(invalid, dir), /BROKER_CONFIG_REQUIRED/);
  await assert.rejects(loadConfig(join(dir, 'missing'), dir), /BROKER_CONFIG_NOT_INITIALIZED/);
  const link = join(dir, 'linked.json'); await symlink(path, link);
  await assert.rejects(loadConfig(link, dir), /CONFIG_MUST_BE_PRIVATE/);
  await writeFile(legacy, '{', { mode: 0o600 });
  await assert.rejects(loadConfig(undefined, dir), /INVALID_CONFIG/);
});
