import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { applyQuota } from '../build/policy.mjs';
import { CodexProvider } from '../build/provider.mjs';
import { Broker } from '../build/broker.mjs';
import { Store, STATE_LIMIT } from '../build/store.mjs';
import { Fault, credential } from '../build/model.mjs';
import { temp, fixtureCommand, auth, until } from './helpers.mjs';
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
test('public device logins cannot consume the reserved refresh slot', async t => {
  const dir = await temp(), provider = new CodexProvider(join(dir, 'runtimes'), await fixtureCommand(dir, 'hang'));
  t.after(async () => { await provider.close(); await rm(dir, { recursive: true, force: true }); });
  const abort = new AbortController(); let waiting = 0;
  const logins = Array.from({ length: 3 }, () => provider.login(abort.signal, () => waiting++));
  logins.forEach(p => p.catch(() => {})); await until(() => waiting === 3);
  await assert.rejects(provider.login(abort.signal, () => {}), /PROVIDER_BUSY/);
  const refreshed = await provider.refresh(credential(auth('a')), abort.signal);
  assert.equal(refreshed.credential.accountId, 'a');
  abort.abort(); await Promise.allSettled(logins);
});
test('provider admission failure preserves healthy credentials and permits subsequent refresh', async t => {
  const dir = await temp(); let busy = true;
  const broker = new Broker(await Store.open(dir), { close: async () => {}, refresh: async () => {
    if (busy) throw new Fault('PROVIDER_BUSY', 429);
    return { credential: credential(auth('a')), identity: '', usage: null };
  } }, []);
  t.after(async () => { await broker.close(); await rm(dir, { recursive: true, force: true }); });
  const id = await broker.importAccount('Example user', [], auth('a'));
  await assert.rejects(broker.refresh(id), /PROVIDER_BUSY/);
  assert.equal(broker.view().accounts[0].authState, 'verified');
  busy = false; await broker.refresh(id);
  assert.equal(broker.view().accounts[0].lastError, null);
});
test('late authentication rejection cannot quarantine a newer credential generation', async t => {
  const dir = await temp(), store = await Store.open(dir);
  const broker = new Broker(store, { close: async () => {}, refresh: async () => ({ credential: credential(auth('a')), identity: '', usage: null }) }, []);
  t.after(async () => { await broker.close(); await rm(dir, { recursive: true, force: true }); });
  const id = await broker.importAccount('Example user', [], auth('a'));
  const old = store.snapshot().accounts[0].generation;
  await broker.refresh(id);
  await broker.observe(id, 'caller', 401, old);
  assert.equal(broker.view().accounts[0].authState, 'verified');
  await broker.refresh(id);
  const current = store.snapshot().accounts[0].generation;
  assert.notEqual(current, old);
  await broker.observe(id, 'caller', 403, current);
  assert.equal(broker.view().accounts[0].authState, 'required');
  await broker.importAccount('Example user', [], auth('a'));
  await broker.observe(id, 'caller', 401, current);
  assert.equal(broker.view().accounts[0].authState, 'verified');
});
test('oversized state is rejected before commit without poisoning the last reopenable state', async t => {
  const dir = await temp(); let store = await Store.open(dir);
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  await store.change(s => { s.padding = 'x'.repeat(STATE_LIMIT - 1024); });
  await assert.rejects(store.change(s => { s.padding += 'x'.repeat(2048); }), /STATE_TOO_LARGE/);
  assert.equal(store.snapshot().padding.length, STATE_LIMIT - 1024);
  await store.change(s => { s.counters.selected++; }); // Size rejection is not a poisoned disk write.
  await store.close(); store = await Store.open(dir);
  assert.equal(store.snapshot().counters.selected, 1);
});
test('cancellation wins while activation waits in the store queue, not after commit', async t => {
  const dir = await temp(), store = await Store.open(dir);
  const broker = new Broker(store, { close: async () => {}, login: async () => ({ credential: credential(auth('a')), identity: 'example@example.invalid' }) }, []);
  t.after(async () => { await broker.close(); await rm(dir, { recursive: true, force: true }); });
  const change = store.change.bind(store); let release, queued = false;
  const gate = new Promise(r => release = r);
  store.change = async f => { queued = true; await gate; return change(f); };
  const first = broker.startEnrollment(); await until(() => queued);
  const cancelled = broker.cancelEnrollment(first.id); release(); await cancelled;
  assert.equal(broker.enrollment(first.id).state, 'cancelled'); assert.equal(broker.view().accounts.length, 0);
  store.change = change;
  const second = broker.startEnrollment(); await until(() => broker.enrollment(second.id).state === 'completed');
  await broker.cancelEnrollment(second.id);
  assert.equal(broker.enrollment(second.id).state, 'completed'); assert.equal(broker.view().accounts.length, 1);
});
