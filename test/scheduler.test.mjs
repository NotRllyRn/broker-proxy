import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../build/store.mjs';
import { Broker } from '../build/broker.mjs';
import { Fault } from '../build/model.mjs';
import { ProviderAdmissionFault } from '../build/provider.mjs';
import { trackResets, RESET_GRACE, RETRY_MIN } from '../build/scheduler.mjs';
import { temp, auth, usage, until } from './helpers.mjs';

async function setup(t) {
  const dir = await temp(); let now = 1900000000000, calls = 0, refreshes = 0, active = 0, max = 0;
  let payload = usage(10, 20, now + 3600000), outcome = 'completed', hook, prepare;
  const provider = {
    async prepare(signal) { if (prepare) await prepare(signal); },
    async refresh(saved) { refreshes++; return { credential: saved, identity: '', usage: payload, usageStartedAt: now, observedAt: now }; },
    async pulse(saved, signal, control) {
      active++; max = Math.max(max, active);
      try {
        const can = await control.preflight(payload, now, now);
        if (hook) await hook(signal);
        if (can) { await control.dispatch(); calls++; }
        return { credential: { ...saved, auth: { ...saved.auth, checkpoint: true } }, identity: '', usage: payload, usageStartedAt: now, observedAt: now, pulse: { status: can ? outcome : 'skipped' } };
      } finally { active--; }
    },
    async close() {},
  };
  let store = await Store.open(join(dir, 'data')), broker = new Broker(store, provider, [], () => now);
  t.after(async () => { await broker.close(); await rm(dir, { recursive: true, force: true }); });
  const add = label => broker.importAccount(label, [], auth(label, now + 365 * 86400000));
  const id = await add('Personal usage');
  return { id, add, provider, get broker() { return broker; }, get store() { return store; }, get now() { return now; }, set now(v) { now = v; },
    set payload(v) { payload = v; }, set outcome(v) { outcome = v; }, set hook(v) { hook = v; }, set prepare(v) { prepare = v; },
    get calls() { return calls; }, get refreshes() { return refreshes; }, get max() { return max; },
    account: () => store.snapshot().accounts.find(a => a.id === id),
    enable: () => broker.setPulseSettings({ enabled: true, short: true, weekly: true, spacingMs: 60000 }),
    async restart() { await broker.close(); store = await Store.open(join(dir, 'data')); broker = new Broker(store, provider, [], () => now); },
  };
}

test('default off; enabling seeds once; global pacing and durable state survive restart', async t => {
  const s = await setup(t); await s.broker.schedulerTick(); assert.equal(s.calls, 0);
  await s.enable(); await Promise.all([s.broker.schedulerTick(), s.broker.schedulerTick()]);
  assert.equal(s.calls, 1); assert.equal(s.account().pulse.last.status, 'completed'); assert.equal(s.account().credential.auth.checkpoint, true);
  await s.add('Work laptop'); await s.restart(); await s.broker.schedulerTick(); assert.equal(s.calls, 1);
  s.now += 60000; await s.broker.schedulerTick(); assert.equal(s.calls, 2); assert.equal(s.max, 1);
  assert.equal(s.store.snapshot().pulseSettings.enabled, true);
});

test('short+weekly resets coalesce, 45s grace and advanced fresh provider windows required; clock never unlocks', async t => {
  const s = await setup(t); await s.enable(); await s.broker.schedulerTick();
  const target = s.now + 600000;
  await s.store.change(state => { const a = state.accounts[0]; a.quota.short.reset = target; a.quota.weekly.reset = target; a.quota.short.used = 100; a.quota.weekly.used = 100; trackResets(a, s.now); });
  s.now = target + RESET_GRACE - 1; await s.broker.schedulerTick(); assert.equal(s.calls, 1); assert.equal(s.account().quota.short.used, 100);
  // An unchanged reset is not confirmation, even if quota reports available.
  s.payload = usage(0, 0, target); s.now++;
  await s.broker.schedulerTick(); assert.equal(s.calls, 1); assert.equal(s.account().pulse.last.status, 'skipped');
  s.now += RETRY_MIN; s.payload = usage(0, 0, s.now + 3600000);
  await s.broker.schedulerTick(); assert.equal(s.calls, 2);
  assert.deepEqual(s.account().pulse.handled, { short: target, weekly: target });
  await s.restart(); s.now += RETRY_MIN; await s.broker.schedulerTick(); assert.equal(s.calls, 2);
});

test('refresh during grace retains the pending reset; weekly-only setting ignores short reset', async t => {
  const s = await setup(t); await s.enable(); await s.broker.schedulerTick();
  const target = s.account().quota.short.reset;
  s.now = target + 1; s.payload = usage(0, 0, target + 3600000);
  await s.broker.refresh(s.id); assert.equal(s.account().pulse.targets.short, target);
  s.now = target + RESET_GRACE; await s.broker.schedulerTick(); assert.equal(s.calls, 2);
  await s.broker.setPulseSettings({ enabled: true, short: false, weekly: true, spacingMs: 60000 });
  const next = s.account().quota.short.reset; s.now = next + RESET_GRACE;
  s.payload = usage(0, 0, next + 3600000); await s.broker.schedulerTick(); assert.equal(s.calls, 2);
});

test('uncertain turn never replays same trigger; confirmation read precedes a later reset pulse', async t => {
  const s = await setup(t); s.outcome = 'uncertain'; await s.enable(); await s.broker.schedulerTick();
  assert.equal(s.calls, 1); assert.equal(s.account().pulse.needsConfirmation, true);
  await assert.rejects(s.broker.pulse(s.id), /PULSE_CONFIRMATION_REQUIRED/);
  s.now += RETRY_MIN * 2; await s.broker.schedulerTick();
  assert.equal(s.calls, 1); assert.equal(s.refreshes, 1); assert.equal(s.account().pulse.needsConfirmation, false);
  await s.restart(); s.now += RETRY_MIN; await s.broker.schedulerTick(); assert.equal(s.calls, 1);
  s.now = s.account().pulse.targets.short + RESET_GRACE; s.payload = usage(0, 0, s.now + 3600000); s.outcome = 'completed';
  await s.broker.schedulerTick(); assert.equal(s.calls, 2);
});

test('crash recovery quarantines interrupted credentials and confirms ambiguous pulse after reauthorization without replay', async t => {
  const s = await setup(t); await s.enable(); await s.broker.schedulerTick();
  await s.store.change(state => { const a = state.accounts[0]; a.authState = 'refreshing'; a.pulse.last.status = 'running'; });
  await s.restart(); assert.equal(s.account().authState, 'required'); assert.equal(s.account().pulse.needsConfirmation, true);
  await s.broker.schedulerTick(); assert.equal(s.calls, 1);
  await s.broker.importAccount('Personal usage', [], auth('Personal usage', s.now + 365 * 86400000));
  s.now += RETRY_MIN; await s.broker.schedulerTick(); assert.equal(s.refreshes, 1); assert.equal(s.calls, 1);
  assert.equal(s.account().pulse.needsConfirmation, false);
});

test('unknown or exhausted usage backs off durably without inference or clearing a quota block', async t => {
  const s = await setup(t); s.payload = {}; await s.enable(); await s.broker.schedulerTick(); assert.equal(s.calls, 0);
  const retry = s.account().pulse.nextAttemptAt; assert.equal(retry, s.now + RETRY_MIN);
  await s.restart(); s.now = retry - 1; await s.broker.schedulerTick(); assert.equal(s.calls, 0);
  s.now++; s.payload = usage(100, 0, s.now + 600000); await s.broker.schedulerTick(); assert.equal(s.calls, 0);
  assert.equal(s.account().pulse.nextAttemptAt, s.now + 2 * RETRY_MIN);
  await s.store.change(state => { state.accounts[0].blockedAt = s.now; });
  s.now += 1; s.payload = usage(0, 0, s.now + 600000); await s.broker.refresh(s.id); assert.notEqual(s.account().blockedAt, null);
  s.now += RESET_GRACE; await s.broker.refresh(s.id); assert.equal(s.account().blockedAt, null);
});

test('refresh and pulse are single flight; disable and settings changes stop inference before dispatch', async t => {
  for (const change of ['account', 'settings']) {
    const s = await setup(t); await s.enable(); let release, entered = false;
    s.hook = async () => { entered = true; await new Promise(r => { release = r; }); };
    const work = s.broker.pulse(s.id, true); await until(() => entered);
    const refresh = s.broker.refresh(s.id); await assert.rejects(s.broker.pulse(s.id), /ACCOUNT_BUSY/);
    if (change === 'account') await s.broker.setAccount(s.id, false);
    else await s.broker.setPulseSettings({ enabled: false, short: true, weekly: true, spacingMs: 60000 });
    release(); await assert.rejects(work, /ACCOUNT_CHANGED/); await assert.rejects(refresh, /ACCOUNT_CHANGED/);
    assert.equal(s.calls, 0); assert.equal(s.refreshes, 0);
    if (change === 'account') assert.equal(s.account().enabled, false);
  }
});

test('late provider completion checkpoints rotation but does not resurrect concurrent auth rejection', async t => {
  const s = await setup(t);
  s.hook = async () => { await s.broker.observe(s.id, '', 401, s.account().generation); };
  await assert.rejects(s.broker.pulse(s.id), /ACCOUNT_CHANGED/);
  assert.equal(s.account().authState, 'required'); assert.equal(s.calls, 0);
  // Refresh completion has the same generation/auth protection.
  await s.broker.importAccount('Personal usage', [], auth('Personal usage', s.now + 365 * 86400000));
  s.provider.refresh = async saved => { await s.broker.observe(s.id, '', 401, s.account().generation); return { credential: saved, identity: '', usage: usage() }; };
  await s.broker.refresh(s.id); assert.equal(s.account().authState, 'required');
});

test('prepare failure/admission backpressure backs off without quarantining healthy credentials', async t => {
  const s = await setup(t); await s.enable(); s.prepare = async () => { throw new Fault('CODEX_INSTALL_FAILED'); };
  await assert.rejects(s.broker.schedulerTick(), /CODEX_INSTALL_FAILED/);
  assert.equal(s.account().authState, 'verified'); assert.equal(s.account().pulse.nextAttemptAt, s.now + RETRY_MIN);
  s.now += RETRY_MIN; s.prepare = undefined; s.provider.pulse = async () => { throw new ProviderAdmissionFault('PROVIDER_BUSY'); };
  await assert.rejects(s.broker.schedulerTick(), /PROVIDER_BUSY/); assert.equal(s.account().authState, 'verified'); assert.equal(s.calls, 0);
});

test('routing waits for pulse checkpoint and rechecks caller after waiting', async t => {
  const s = await setup(t); let release, entered = false;
  const caller = await s.broker.addCaller('Work laptop', 'fixture-secret-012345678901234567890', [], []);
  s.hook = async () => { entered = true; await new Promise(r => { release = r; }); };
  const pulse = s.broker.pulse(s.id); await until(() => entered);
  let selected = false;
  const selection = s.broker.select(caller, '', 'fixture-exchange', 0, new AbortController().signal).then(a => { selected = true; return a; });
  assert.equal(selected, false); await s.broker.setCaller(caller, false); release(); await pulse;
  await assert.rejects(selection, /ACCOUNT_CHANGED/); assert.equal(s.account().credential.auth.checkpoint, true);
  await s.broker.setCaller(caller, true);
  const routed = await s.broker.select(caller, '', 'fixture-exchange-2', 0, new AbortController().signal);
  assert.equal(routed.credential.auth.checkpoint, true);
  assert.equal(routed.generation, s.account().generation);
});

test('generation replacement/deletion cannot be resurrected by completion', async t => {
  const s = await setup(t);
  s.provider.refresh = async saved => { await s.store.change(state => { state.accounts[0].generation = 'replacement'; }); return { credential: saved, identity: '', usage: usage() }; };
  await assert.rejects(s.broker.refresh(s.id), /ACCOUNT_CHANGED/); assert.equal(s.account().generation, 'replacement');
  await s.store.change(state => { state.accounts[0].authState = 'verified'; });
  s.provider.refresh = async saved => { await s.store.change(state => { state.accounts = []; }); return { credential: saved, identity: '', usage: usage() }; };
  await assert.rejects(s.broker.refresh(s.id), /ACCOUNT_CHANGED/); assert.equal(s.store.snapshot().accounts.length, 0);
});
