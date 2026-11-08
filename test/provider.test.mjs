import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexProvider } from '../build/provider.mjs';
import { credential } from '../build/model.mjs';
import { temp, fixtureCommand, auth } from './helpers.mjs';
for (const mode of ['success', 'denied', 'mismatch', 'unsafe-url', 'hang', 'malformed', 'expired']) test(`isolated app-server device protocol: ${mode}`, async t => {
  const dir = await temp(), command = await fixtureCommand(dir, mode);
  const provider = new CodexProvider(join(dir, 'runtimes'), command);
  t.after(async () => { await provider.close(); await rm(dir, { recursive: true, force: true }); });
  let waiting;
  const signal = AbortSignal.timeout(mode === 'hang' ? 300 : 5000);
  const promise = provider.login(signal, device => waiting = device);
  if (mode === 'success') {
    const result = await promise; assert.equal(result.credential.accountId, 'fixture-account'); assert.equal(result.identity, 'example@example.invalid');
    assert.equal(waiting.code, 'FIXTURE-NOT-LIVE');
  } else await assert.rejects(promise, /LOGIN_FAILED|UNSAFE_PROVIDER_URL|CANCELLED|PROVIDER_PROTOCOL_ERROR|LOGIN_EXPIRED/);
  assert.deepEqual(await readdir(join(dir, 'runtimes')), []);
});
test('refresh checkpoints rotated auth from isolated app-server; diagnostics sanitized', async t => {
  const dir = await temp(); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const mode of ['success', 'refresh-failure']) {
    const provider = new CodexProvider(join(dir, 'runtimes'), await fixtureCommand(dir, mode));
    const result = provider.refresh(credential(auth('existing')), AbortSignal.timeout(5000));
    if (mode === 'success') assert.equal((await result).credential.accountId, 'existing');
    else await assert.rejects(result, e => e.message === 'PROVIDER_RPC_FAILED');
    await provider.close();
  }
});
