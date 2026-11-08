import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { applyQuota } from '../build/policy.mjs';
import { CodexProvider } from '../build/provider.mjs';
import { temp, fixtureCommand } from './helpers.mjs';
test('older completion cannot replace a newer exhausted observation even with a later start', () => {
  const q = (start, observed, used) => ({ startedAt: start, observedAt: observed, short: { used, reset: 900 }, weekly: { used, reset: 999 } });
  const a = { quota: q(100, 400, 100), blockedAt: null };
  applyQuota(a, q(200, 300, 0)); assert.equal(a.quota.short.used, 100);
  applyQuota(a, q(100, 300, 0)); assert.equal(a.quota.short.used, 100);
});
test('provider close covers in-flight directory creation and waits for complete cleanup', async t => {
  const dir = await temp(); t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = new CodexProvider(join(dir, 'runtimes'), await fixtureCommand(dir, 'hang'));
  const work = provider.login(new AbortController().signal, () => {});
  work.catch(() => {});
  await provider.close(); await assert.rejects(work, /CANCELLED/);
  assert.deepEqual(await readdir(join(dir, 'runtimes')), []);
});
