import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, chmod, rm } from 'node:fs/promises';
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
  await save({ enrollment: { host: '0.0.0.0', origin: 'https://enroll.example.invalid' }, pollMs: 0 });
  assert.equal((await loadConfig(path)).enrollment.origin, 'https://enroll.example.invalid');
});
