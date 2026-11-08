import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../build/store.mjs';
import { Broker } from '../build/broker.mjs';
import { credential } from '../build/model.mjs';
import { temp, auth, usage, until } from './helpers.mjs';

async function fixture(t, provider = {}) {
  const dir = await temp(), store = await Store.open(join(dir, 'state'));
  const broker = new Broker(store, { close: async () => {}, ...provider }, ['Personal usage']);
  t.after(async () => { await broker.close(); await rm(dir, { recursive: true, force: true }); });
  const caller = await broker.addCaller('Work laptop', 'fixture-caller-secret-01234567890123456789', ['Personal usage'], []);
  return { broker, store, dir, caller };
}
test('durable private state, single instance lock, credential-free dashboard views', async t => {
  const { broker, store, dir } = await fixture(t);
  await broker.importAccount('Example user', ['Personal usage'], auth());
  assert.equal((await stat(join(dir, 'state', 'state.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, 'state'))).mode & 0o777, 0o700);
  await assert.rejects(Store.open(join(dir, 'state')), /STATE_LOCKED/);
  assert.doesNotMatch(JSON.stringify(broker.view()), /fixture-refresh|access_token|refresh_token|not-a-real-signature|digest/);
  const disk = JSON.parse(await readFile(join(dir, 'state', 'state.json')));
  assert.equal(disk.accounts.length, 1); assert.equal(store.snapshot().accounts.length, 1);
});
test('singleflight refresh with independently cancelled waiter, and persisted rotated credential', async t => {
  let calls = 0, release;
  const gate = new Promise(r => release = r);
  const { broker, caller, store } = await fixture(t, { refresh: async () => { calls++; await gate; return { credential: credential(auth('a')), identity: 'example@example.invalid', usage: usage() }; } });
  const id = await broker.importAccount('Example user', ['Personal usage'], auth('a', Date.now() + 60000));
  const cancel = new AbortController();
  const p1 = broker.select(caller, '', 'one', 1, cancel.signal);
  await until(() => calls === 1);
  const p2 = broker.select(caller, '', 'two', 1, new AbortController().signal);
  cancel.abort(); await assert.rejects(p1, /CANCELLED/);
  release(); assert.equal((await p2).id, id); assert.equal(calls, 1);
  assert.equal(store.snapshot().accounts[0].authState, 'verified');
  assert.equal(broker.view().history.length, 1);
});
test('deactivation and caller revocation during refresh cannot be resurrected', async t => {
  let release, calls = 0; const gate = new Promise(r => release = r);
  const { broker, caller } = await fixture(t, { refresh: async () => { calls++; await gate; return { credential: credential(auth('a')), identity: '', usage: usage() }; } });
  const id = await broker.importAccount('Example user', ['Personal usage'], auth('a', Date.now() + 60000));
  const pending = broker.select(caller, '', 'one', 1, new AbortController().signal);
  await until(() => calls === 1); await broker.setAccount(id, false); await broker.setCaller(caller, false); release();
  await assert.rejects(pending, /ACCOUNT_CHANGED/); assert.equal(broker.view().accounts[0].enabled, false);
});
test('persistence failure prevents publication and poisons subsequent routing', async t => {
  const { broker, dir } = await fixture(t);
  await mkdir(join(dir, 'state', 'state.next'));
  await assert.rejects(broker.importAccount('Example user', [], auth()), /PERSISTENCE_FAILED/);
  assert.throws(() => broker.view(), /STORE_UNAVAILABLE/);
  const state = JSON.parse(await readFile(join(dir, 'state', 'state.json'))); assert.equal(state.accounts.length, 0);
});
test('restart quarantines interrupted refresh; completion is durable before activation', async t => {
  const dir = await temp(); t.after(() => rm(dir, { recursive: true, force: true }));
  let store = await Store.open(join(dir, 'state'));
  const broker = new Broker(store, { close: async () => {} }, []);
  await broker.importAccount('Example user', [], auth());
  await store.change(s => { s.accounts[0].authState = 'refreshing'; }); await broker.close();
  store = await Store.open(join(dir, 'state'));
  assert.equal(store.snapshot().accounts[0].authState, 'required'); await store.close();
});
test('global 429 block spans callers; 5xx exclusion remains scoped', async t => {
  const { broker, caller } = await fixture(t);
  const other = await broker.addCaller('Personal usage', 'another-fixture-secret-012345678901234567', [], []);
  const id = await broker.importAccount('Example user', ['Personal usage'], auth());
  await broker.observe(id, caller, 500);
  await assert.rejects(broker.select(caller, '', 'one', 1, new AbortController().signal), /POOL_AWAITING_CONFIRMATION/);
  assert.equal((await broker.select(other, '', 'two', 1, new AbortController().signal)).id, id);
  await broker.observe(id, other, 429);
  await assert.rejects(broker.select(other, '', 'three', 1, new AbortController().signal), /POOL_AWAITING_CONFIRMATION/);
});
