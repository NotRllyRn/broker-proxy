import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../build/store.mjs';
import { Broker } from '../build/broker.mjs';
import { CodexProvider } from '../build/provider.mjs';
import { startWeb } from '../build/web.mjs';
import { digest } from '../build/model.mjs';
import { temp, port, fixtureCommand, until } from './helpers.mjs';

export function browser(origin) {
  let cookie = '', csrf = '';
  return {
    get csrf() { return csrf; },
    async request(path = '/', data, extra = {}) {
      const res = await fetch(origin + path, { method: data ? 'POST' : 'GET', redirect: 'manual', headers: {
        Cookie: cookie, ...(data ? { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...extra,
      }, body: data ? new URLSearchParams({ csrf, ...data }) : undefined });
      if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
      const text = await res.text(); csrf = text.match(/name="csrf" value="([^"]+)"/)?.[1] ?? csrf;
      return { status: res.status, text, headers: res.headers };
    },
  };
}
test('two real HTTP services: admin auth, CSRF, enrollment ownership, activation, duplicate, cancellation and isolation', async t => {
  const dir = await temp(), dashboardPort = await port(), enrollmentPort = await port();
  const config = { dataDir: join(dir, 'state'), adminHash: digest('fixture-admin-secret'), dashboard: { host: '127.0.0.1', port: dashboardPort, origin: `http://127.0.0.1:${dashboardPort}` }, enrollment: { host: '127.0.0.1', port: enrollmentPort, origin: `http://127.0.0.1:${enrollmentPort}` } };
  const broker = new Broker(await Store.open(config.dataDir), new CodexProvider(join(dir, 'runtimes'), await fixtureCommand(dir)), ['Personal usage']);
  const close = await startWeb(broker, config);
  t.after(async () => { await close(); await broker.close(); await rm(dir, { recursive: true, force: true }); });
  const admin = browser(config.dashboard.origin), publicBrowser = browser(config.enrollment.origin), other = browser(config.enrollment.origin);
  assert.equal((await admin.request('/api/status')).status, 401);
  const login = await admin.request(); assert.match(login.text, /Sign in/); assert.match(login.headers.get('set-cookie') ?? '', /^$/); // already owns a session
  assert.equal((await admin.request('/login', { secret: 'wrong' })).status, 401);
  assert.equal((await admin.request('/login', { secret: 'fixture-admin-secret' }, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await admin.request('/login', { secret: 'fixture-admin-secret', csrf: 'wrong' })).status, 403);
  assert.equal((await admin.request('/login', { secret: 'fixture-admin-secret' })).status, 303);
  await admin.request();
  const home = await publicBrowser.request(); assert.match(home.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await publicBrowser.request('/start', {})).status, 303);
  assert.deepEqual(JSON.parse((await other.request('/status')).text), { state: 'idle' });
  await other.request();
  assert.equal((await other.request('/account/state', { id: 'x' })).status, 404);
  await until(async () => JSON.parse((await publicBrowser.request('/status')).text).state === 'completed');
  const status = await admin.request('/api/status'); assert.equal(JSON.parse(status.text).accounts.length, 1);
  assert.doesNotMatch(status.text, /fixture-refresh|not-a-real-signature|access_token|example@example/);
  assert.equal((await publicBrowser.request('/api/status')).status, 404);
  assert.equal((await publicBrowser.request('/start', {})).status, 303);
  await until(async () => JSON.parse((await publicBrowser.request('/status')).text).state === 'failed');
  assert.match((await publicBrowser.request('/status')).text, /DUPLICATE_ACCOUNT/);
  const id = JSON.parse(status.text).accounts[0].id;
  assert.equal((await admin.request('/account/state', { id, enabled: 'false' })).status, 303);
  assert.equal(JSON.parse((await admin.request('/api/status')).text).accounts[0].enabled, false);
  assert.equal((await admin.request('/caller/add', { label: 'Work laptop', secret: 'fixture-caller-secret-01234567890123456789', allow: 'Personal usage', block: '' })).status, 303);
  assert.equal(broker.view().callers.length, 1);
});
test('public cancellation terminates runtime and restart invalidates enrollment sessions', async t => {
  const dir = await temp();
  const provider = new CodexProvider(join(dir, 'runtimes'), await fixtureCommand(dir, 'hang'));
  const broker = new Broker(await Store.open(join(dir, 'state')), provider, []);
  t.after(async () => { await broker.close(); await rm(dir, { recursive: true, force: true }); });
  const e = broker.startEnrollment();
  await until(() => broker.enrollment(e.id).state === 'waiting');
  await broker.cancelEnrollment(e.id); assert.equal(broker.enrollment(e.id).state, 'cancelled');
  assert.equal(broker.view().accounts.length, 0);
});
test('second-listener startup failure releases first port', async t => {
  const dir = await temp(); const a = await port(), b = await port();
  const { createServer } = await import('node:http');
  const occupied = createServer(); await new Promise(r => occupied.listen(b, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => occupied.close(r)); await rm(dir, { recursive: true, force: true }); });
  const config = { dashboard: { host: '127.0.0.1', port: a, origin: `http://127.0.0.1:${a}` }, enrollment: { host: '127.0.0.1', port: b, origin: `http://127.0.0.1:${b}` } };
  await assert.rejects(startWeb({}, config), /EADDRINUSE/);
  const check = createServer(); await new Promise((resolve, reject) => check.once('error', reject).listen(a, '127.0.0.1', resolve)); await new Promise(r => check.close(r));
});
