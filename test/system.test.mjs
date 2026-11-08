import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { readFile, writeFile, rm, access } from 'node:fs/promises';
import { Store } from '../build/store.mjs';
import { Broker } from '../build/broker.mjs';
import { digest } from '../build/model.mjs';
import { temp, port, auth, browser, until, fixtureCommand, delay } from './helpers.mjs';
const exec = promisify(execFile);

test('real GitHub CLI installation → compiled ProxyKit → installed Node worker → upstream; lifecycle and managed fallback', { timeout: 120000 }, async t => {
  const dir = await temp(), dataDir = join(dir, 'data');
  const binary = process.env.PROXYKIT_BINARY || '/tmp/broker-proxy-proxykit';
  const ref = process.env.BROKER_TEST_REF || (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
  const env = { ...process.env, PROXYKIT_EXTENSIONS_DIR: join(dir, 'extensions'), BROKER_CONFIG: join(dir, 'config.json') };
  const installed = await exec(binary, ['extension', 'install', `https://github.com/NotRllyRn/broker-proxy/tree/${ref}`, '--trust'], { env });
  assert.match(installed.stdout + installed.stderr, /Installed broker-proxy/);
  const installation = JSON.parse(await readFile(join(env.PROXYKIT_EXTENSIONS_DIR, 'broker-proxy', 'installation.json')));
  assert.ok(JSON.stringify(installation).includes(ref));
  const shippedLock = await readFile(join(env.PROXYKIT_EXTENSIONS_DIR, 'broker-proxy', 'package', 'codex', 'package-lock.json'));
  assert.deepEqual(shippedLock, await readFile(new URL('../codex/package-lock.json', import.meta.url)));
  const dataPort = await port(), adminPort = await port(), publicPort = await port(), upstreamPort = await port();
  const origin = `http://127.0.0.1:${dataPort}`, adminOrigin = `http://127.0.0.1:${adminPort}`, publicOrigin = `http://127.0.0.1:${publicPort}`;
  const upstreamRequests = []; let cancelled = false;
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    upstreamRequests.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (req.url.includes('fallback') && req.headers['chatgpt-account-id'] === 'a') { res.writeHead(503); res.end('retryable'); return; }
    if (req.url.includes('stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"delta":"');
      const timer = setTimeout(() => res.end('hello"}\n\ndata: [DONE]\n\n'), 80);
      res.on('close', () => clearTimeout(timer)); return;
    }
    if (req.url.includes('cancel')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: started\n\n');
      res.on('close', () => { cancelled = true; }); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ account: req.headers['chatgpt-account-id'] }));
  });
  await new Promise(r => upstream.listen(upstreamPort, '127.0.0.1', r));
  const seed = new Broker(await Store.open(dataDir), { close: async () => {} }, []);
  const caller = 'fixture-system-caller-012345678901234567890';
  const scoped = 'fixture-scoped-caller-012345678901234567890';
  await seed.addCaller('Work laptop', caller, [], []);
  const extraCallers = Object.fromEntries(['POST', 'HEAD', 'OPTIONS', 'implicit'].map(name => [name, `fixture-${name}-caller-012345678901234567890`]));
  for (const secret of Object.values(extraCallers)) await seed.addCaller('Work laptop', secret, [], []);
  await seed.addCaller('Personal usage', scoped, ['private'], []);
  const alpha = auth('a');
  const a = await seed.importAccount('Example user', ['private'], alpha);
  await seed.importAccount('Personal usage', ['shared'], auth('b'));
  await seed.close();
  await writeFile(env.BROKER_CONFIG, JSON.stringify({ dataDir, adminHash: digest('fixture-admin-secret'), upstream: `http://127.0.0.1:${upstreamPort}/backend`,
    dashboard: { port: adminPort }, enrollment: { port: publicPort }, codexCommand: await fixtureCommand(dir), pollMs: 0, safeFallback: true }), { mode: 0o600 });
  let child, logs = '';
  const start = async () => {
    child = spawn(binary, ['-listen', `127.0.0.1:${dataPort}`, '-upstream', `http://127.0.0.1:${upstreamPort}`, '-node', process.execPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
    await until(async () => {
      if (child.exitCode !== null) throw Error('ProxyKit exited: ' + logs);
      try { return (await fetch(adminOrigin)).status === 200; } catch { return false; }
    }, 15000);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 7000);
    const [code, signal] = await exited; clearTimeout(kill);
    assert.equal(signal, null, logs); assert.equal(code, 0, logs);
  };
  t.after(async () => { await stop(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); await rm(dir, { recursive: true, force: true }); });
  await start();
  assert.equal((await fetch(origin + '/v1/responses')).status, 401);
  const request = (path, secret = caller, options = {}) => fetch(origin + path, { ...options, headers: { Authorization: `Bearer ${secret}`, ...(options.headers ?? {}) } });
  const response = await request('/v1/responses', caller, { method: 'POST', body: '{"input":"fixture"}', headers: { 'Content-Type': 'application/json', Cookie: 'private-cookie', 'X-Api-Key': 'private-key', 'X-Broker-Caller': 'forged' } });
  assert.equal(response.status, 200, await response.clone().text()); assert.deepEqual(await response.json(), { account: 'a' });
  const first = upstreamRequests[0]; assert.equal(first.path, '/backend/responses'); assert.equal(first.body, '{"input":"fixture"}');
  assert.equal(first.headers.authorization, 'Bearer ' + alpha.tokens.access_token);
  assert.equal(first.headers.cookie, undefined); assert.equal(first.headers['x-api-key'], undefined); assert.equal(first.headers['x-broker-caller'], undefined);
  const beforeTrailers = upstreamRequests.length;
  const trailers = await new Promise((resolve, reject) => {
    const req = httpRequest(origin + '/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${caller}`, Trailer: 'Authorization, Cookie, X-Api-Key' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.write('{}');
    req.addTrailers({ Authorization: 'private-trailer', Cookie: 'private-trailer', 'X-Api-Key': 'private-trailer' }); req.end();
  });
  assert.equal(trailers, 400); assert.equal(upstreamRequests.length, beforeTrailers);
  const stream = await request('/v1/responses?stream', caller, { method: 'POST', body: '{}', headers: { Accept: 'text/event-stream' } });
  assert.equal(await stream.text(), 'data: {"delta":"hello"}\n\ndata: [DONE]\n\n');
  const abort = new AbortController(); const cancelledResponse = await request('/v1/responses?cancel', caller, { method: 'POST', body: '{}', signal: abort.signal });
  await cancelledResponse.body.getReader().read(); abort.abort(); await until(() => cancelled);
  const before = upstreamRequests.length;
  // fetch elides Content-Length: 0 on GET; send the explicit bodyless contract using ordinary node:http.
  const safeRequest = (method, secret) => new Promise((resolve, reject) => {
    const req = httpRequest(origin + '/v1/models?fallback', { method, headers: { Authorization: `Bearer ${secret}`, 'Content-Length': '0' } }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end();
  });
  const fallback = await safeRequest('GET', caller);
  assert.equal(fallback.status, 200, fallback.text + '\n' + logs); assert.deepEqual(JSON.parse(fallback.text), { account: 'b' });
  assert.equal(upstreamRequests.length - before, 2);
  for (const method of ['HEAD', 'OPTIONS']) {
    const count = upstreamRequests.length, result = await safeRequest(method, extraCallers[method]);
    assert.equal(result.status, 200, result.text + logs); assert.equal(upstreamRequests.length - count, 2);
    if (method === 'HEAD') assert.equal(result.text, '');
  }
  for (const method of ['POST', 'implicit']) {
    const count = upstreamRequests.length;
    const result = await request('/v1/responses?fallback', extraCallers[method], method === 'POST' ? { method: 'POST', body: '{}' } : {});
    assert.equal(result.status, 503); await result.text(); assert.equal(upstreamRequests.length - count, 1);
  }
  const scopedResult = await request('/v1/models', scoped); assert.deepEqual(await scopedResult.json(), { account: 'a' });
  const admin = browser(adminOrigin); await admin.request(); await admin.request('/login', { secret: 'fixture-admin-secret' }); await admin.request();
  const status = JSON.parse((await admin.request('/api/status')).text);
  assert.ok(status.history.some(h => h.attempt >= 1));
  assert.equal(status.accounts.length, 2);
  assert.equal(status.pulseSettings.enabled, false);
  assert.ok(status.accounts.find(account => account.id === a).stats.responses > 0);
  assert.equal((await admin.request('/account/pulse', { id: a })).status, 303);
  let pulses = JSON.parse((await admin.request('/api/status')).text);
  assert.equal(pulses.accounts.find(account => account.id === a).pulse.last.status, 'completed');
  assert.equal((await admin.request('/settings/pulses', { enabled: 'true', short: 'true', weekly: 'true', spacingSeconds: '15' })).status, 303);
  await until(async () => {
    pulses = JSON.parse((await admin.request('/api/status')).text);
    return pulses.accounts.some(account => account.id !== a && account.pulse?.last?.automatic && account.pulse.last.status === 'completed');
  }, 35000);
  assert.equal((await admin.request('/settings/pulses', { spacingSeconds: '60' })).status, 303);
  assert.doesNotMatch(JSON.stringify(pulses), /fixture-rotated|access_token|refresh_token/);
  const publicBrowser = browser(publicOrigin); await publicBrowser.request(); await publicBrowser.request('/start', {});
  await until(async () => JSON.parse((await publicBrowser.request('/status')).text).state === 'completed');
  await admin.request('/account/state', { id: a, enabled: 'false' });
  assert.equal((await request('/v1/models', scoped)).status, 503);
  await stop(); await assert.rejects(access(join(dataDir, 'lock')));
  for (const url of [adminOrigin, publicOrigin, origin]) await assert.rejects(fetch(url));
  await start();
  assert.equal((await request('/v1/models', scoped)).status, 503);
  const freshAdmin = browser(adminOrigin); await freshAdmin.request(); await freshAdmin.request('/login', { secret: 'fixture-admin-secret' }); await freshAdmin.request();
  const recovered = JSON.parse((await freshAdmin.request('/api/status')).text);
  assert.equal(recovered.pulseSettings.enabled, false);
  assert.equal(recovered.accounts.find(account => account.id === a).pulse.last.status, 'completed');
  assert.ok(recovered.accounts.some(account => account.pulse?.last?.automatic));
  const freshPublic = browser(publicOrigin); assert.deepEqual(JSON.parse((await freshPublic.request('/status')).text), { state: 'idle' });
  assert.doesNotMatch(logs, /fixture-system-caller|fixture-scoped-caller|fixture-refresh|not-a-real-signature|private-cookie|private-key|private-trailer/);
  await stop();
  await assert.rejects(access(join(dataDir, 'codex'))); // Explicit fixture override must never install the real CLI.
  t.diagnostic(`Verified actual CLI install at ${ref}; two restarts, opaque SSE, cancellation, scoped credentials, managed GET fallback; manual and background scheduled account pulses/settings/stats with isolated app-server fixture (not live-provider verification).`);
});
