import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexProvider } from '../build/provider.mjs';
import { credential } from '../build/model.mjs';
import { Store } from '../build/store.mjs';
import { Broker } from '../build/broker.mjs';
import { pulseModel } from '../build/pulse.mjs';
import { temp, fixtureCommand, auth, until } from './helpers.mjs';

for (const [mode, expected] of [['success', 'completed'], ['pulse-early', 'completed'], ['pulse-error', 'failed'], ['pulse-rpc-error', 'uncertain'], ['pulse-malformed', 'uncertain'], ['pulse-truncated', 'uncertain'], ['pulse-flood', 'uncertain'], ['pulse-hang', 'uncertain']]) {
  test(`isolated account pulse model/thread/turn and rotated credential checkpoint: ${mode}`, { timeout: 10000 }, async t => {
    const dir = await temp(), provider = new CodexProvider(join(dir, 'runtimes'), await fixtureCommand(dir, mode));
    t.after(async () => { await provider.close(); await rm(dir, { recursive: true, force: true }); });
    let dispatched = 0, observed = 0;
    const abort = new AbortController();
    const result = await provider.pulse(credential(auth()), abort.signal, {
      preflight: async (usage, started, finished) => { assert.ok(usage.rateLimits); assert.ok(finished >= started); observed++; return true; },
      dispatch: async () => { dispatched++; if (mode === 'pulse-hang') setTimeout(() => abort.abort(), 100); },
    });
    assert.equal(dispatched, 1); assert.equal(observed, 1); assert.equal(result.pulse.status, expected);
    assert.equal(result.credential.auth.tokens.refresh_token, 'fixture-rotated-after-pulse');
    assert.equal(result.credential.accountId, 'fixture-account');
    assert.doesNotMatch(JSON.stringify(result.pulse), /private|discard/);
    assert.deepEqual(await readdir(join(dir, 'runtimes')), []);
  });
}

test('unconfirmed preflight and final cancelled dispatch never infer; credentials still checkpoint', async t => {
  const dir = await temp(), provider = new CodexProvider(join(dir, 'runtimes'), await fixtureCommand(dir));
  t.after(async () => { await provider.close(); await rm(dir, { recursive: true, force: true }); });
  let dispatched = false;
  const result = await provider.pulse(credential(auth()), new AbortController().signal, { preflight: async () => false, dispatch: async () => { dispatched = true; } });
  assert.equal(result.pulse.status, 'skipped'); assert.equal(dispatched, false);
  assert.notEqual(result.credential.auth.tokens.refresh_token, 'fixture-rotated-after-pulse');
  const cancelled = await provider.pulse(credential(auth()), new AbortController().signal, { preflight: async () => true, dispatch: async () => { throw Error('cancel'); } });
  assert.equal(cancelled.pulse.status, 'failed'); assert.notEqual(cancelled.credential.auth.tokens.refresh_token, 'fixture-rotated-after-pulse');
});

for (const reason of ['disable', 'shutdown', 'caller']) {
  test(`running pulse ${reason} cancellation reaps runtime and durably checkpoints rotated auth`, async t => {
    const dir = await temp(), store = await Store.open(join(dir, 'state'));
    const broker = new Broker(store, new CodexProvider(join(dir, 'runtimes'), await fixtureCommand(dir, 'pulse-hang')), []);
    t.after(async () => { await broker.close(); await rm(dir, { recursive: true, force: true }); });
    const id = await broker.importAccount('Personal usage', [], auth()), abort = new AbortController();
    const work = broker.pulse(id, false, abort.signal);
    await until(() => store.snapshot().accounts[0].pulse.last?.status === 'running');
    // Let the fixture persist its rotation after receiving turn/start.
    const { readFile } = await import('node:fs/promises');
    await until(async () => {
      const runs = await readdir(join(dir, 'runtimes'));
      return runs.length && (await readFile(join(dir, 'runtimes', runs[0], 'auth.json'), 'utf8')).includes('fixture-rotated-after-pulse');
    });
    if (reason === 'disable') await broker.setAccount(id, false);
    else if (reason === 'caller') abort.abort();
    else await broker.close();
    await work;
    const state = reason === 'shutdown' ? JSON.parse(await readFile(join(dir, 'state', 'state.json'), 'utf8')) : store.snapshot();
    const account = state.accounts[0];
    assert.equal(account.credential.auth.tokens.refresh_token, 'fixture-rotated-after-pulse');
    assert.equal(account.pulse.last.status, 'uncertain'); assert.equal(account.pulse.needsConfirmation, true);
    assert.equal(account.authState, 'verified'); if (reason === 'disable') assert.equal(account.enabled, false);
    assert.deepEqual(await readdir(join(dir, 'runtimes')), []);
  });
}

test('model selection rejects unknown catalog instead of guessing a model', () => {
  assert.throws(() => pulseModel({ data: [] }), /PULSE_MODEL_UNKNOWN/);
  assert.throws(() => pulseModel({ data: [{ model: 'image', inputModalities: ['image'], supportedReasoningEfforts: [] }] }), /PULSE_MODEL_UNKNOWN/);
});
