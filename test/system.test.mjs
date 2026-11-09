import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { readFile, writeFile, rm, access, readdir, readlink, stat, cp, chmod } from 'node:fs/promises';
import { Store } from '../build/store.mjs';
import { Broker } from '../build/broker.mjs';
import { digest } from '../build/model.mjs';
import { temp, port, auth, browser, until, fixtureCommand, delay } from './helpers.mjs';
const exec = promisify(execFile);

test('real GitHub CLI installation → compiled ProxyKit → installed Node worker → upstream; hot activation and lifecycle', { timeout: 180000, skip: process.platform !== 'linux' && 'Linux /proc and flock assertions' }, async t => {
  const dir = await temp();
  const binary = process.env.PROXYKIT_BINARY || '/tmp/broker-proxy-proxykit';
  const ref = process.env.BROKER_TEST_REF || (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
  const env = { ...process.env, PROXYKIT_EXTENSIONS_DIR: join(dir, 'extensions') };
  delete env.BROKER_CONFIG;
  const hostDir = join(env.PROXYKIT_EXTENSIONS_DIR, '.data', 'broker-proxy');
  const configPath = join(hostDir, 'config.json');
  let dataDir = join(hostDir, 'data');
  const installed = await exec(binary, ['extension', 'install', `https://github.com/NotRllyRn/broker-proxy/tree/${ref}`, '--trust'], { env });
  assert.match(installed.stdout + installed.stderr, /Installed broker-proxy/);
  const installation = JSON.parse(await readFile(join(env.PROXYKIT_EXTENSIONS_DIR, 'broker-proxy', 'installation.json')));
  assert.equal(installation.commit, ref);
  assert.deepEqual(installation.manifest, JSON.parse(await readFile(new URL('../proxykit-extension.json', import.meta.url))));
  const shippedLock = await readFile(join(env.PROXYKIT_EXTENSIONS_DIR, 'broker-proxy', 'package', 'codex', 'package-lock.json'));
  assert.deepEqual(shippedLock, await readFile(new URL('../codex/package-lock.json', import.meta.url)));
  const offline = await exec(binary, ['extension', 'status', 'broker-proxy'], { env });
  assert.match(offline.stdout + offline.stderr, /broker-proxy\s+0\.1\.0\s+1\s+true\s+false\s+unknown/);
  assert.equal((await stat(hostDir)).mode & 0o7777, 0o700);
  assert.deepEqual(await readdir(hostDir), [], 'install creates only the private directory, without executing package code');
  await exec(binary, ['extension', 'enable', 'broker-proxy'], { env });
  // Actual default setup: no manual initialization, fixture adapter or environment config.
  const bootstrapPort = await port();
  let defaultLogs = '', secrets, secretBytes;
  for (let boot = 0; boot < 2; boot++) {
    const child = spawn(binary, ['-listen', `127.0.0.1:${bootstrapPort}`, '-upstream', 'http://127.0.0.1:1'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => defaultLogs += b); child.stderr.on('data', b => defaultLogs += b);
    let pid;
    try {
      await until(async () => {
        if (child.exitCode !== null) throw Error('Default bootstrap exited: ' + defaultLogs);
        try { return (await fetch('http://127.0.0.1:8788')).status === 200; } catch { return false; }
      }, 15000);
      pid = Number(await readFile(join(dataDir, 'lock'), 'utf8'));
      const bytes = await readFile(join(hostDir, 'secrets.json'));
      if (boot) assert.deepEqual(bytes, secretBytes); else secretBytes = bytes;
      secrets = JSON.parse(bytes);
      const admin = browser('http://127.0.0.1:8788'); await admin.request();
      await admin.request('/login', { secret: secrets.admin }); await admin.request();
      const status = JSON.parse((await admin.request('/api/status')).text);
      assert.equal(status.accounts.length, 0); assert.equal(status.pulseSettings.enabled, false);
      assert.equal((await fetch(`http://127.0.0.1:${bootstrapPort}/v1/models`, { headers: { Authorization: `Bearer ${secrets.caller}` } })).status, 503);
      for (const path of [configPath, join(hostDir, 'secrets.json'), join(dataDir, 'state.json')]) {
        const info = await stat(path); assert.equal(info.mode & 0o7777, 0o600); assert.equal(info.uid, process.getuid());
      }
      assert.equal(JSON.parse(await readFile(configPath)).dataDir, dataDir);
      assert.equal((await stat(dataDir)).mode & 0o7777, 0o700);
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, 'exit'); child.kill('SIGTERM');
        const kill = setTimeout(() => child.kill('SIGKILL'), 7000);
        const [code, signal] = await exited; clearTimeout(kill); assert.equal(signal, null, defaultLogs); assert.equal(code, 0, defaultLogs);
      }
    }
    await assert.rejects(access(join(dataDir, 'lock')));
    if (pid) await assert.rejects(access(`/proc/${pid}`));
    for (const port of [8788, 8789, bootstrapPort]) await assert.rejects(fetch(`http://127.0.0.1:${port}`));
    await exec('flock', ['-n', join(env.PROXYKIT_EXTENSIONS_DIR, '.owner-lock'), 'true']);
  }
  for (const secret of Object.values(secrets)) assert.ok(!defaultLogs.includes(secret));
  await exec(binary, ['extension', 'disable', 'broker-proxy'], { env });
  t.diagnostic('Default install-created empty directory auto-initialized privately on first setup, no BROKER_CONFIG/manual prep; two account-free boots preserve generated credentials, with no inference. Managed Codex preparation may run; fixture phase below explicitly overrides it.');
  // Only this unrelated synthetic extension uses controlled archive transport, never the broker.
  await exec('go', ['run', '.'], { cwd: new URL('./activation-fixture/', import.meta.url), env });
  const ownerLock = join(env.PROXYKIT_EXTENSIONS_DIR, '.owner-lock');
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
  await writeFile(configPath, JSON.stringify({ dataDir, adminHash: digest('fixture-admin-secret'), upstream: `http://127.0.0.1:${upstreamPort}/backend`,
    dashboard: { port: adminPort }, enrollment: { port: publicPort }, codexCommand: await fixtureCommand(dir), pollMs: 0, safeFallback: true }), { mode: 0o600 });
  await exec(binary, ['extension', 'enable', 'broker-proxy'], { env }); // Fixture-only config edits above, while stopped.
  let child, workerPid, logs = '';
  const start = async () => {
    child = spawn(binary, ['-listen', `127.0.0.1:${dataPort}`, '-upstream', `http://127.0.0.1:${upstreamPort}`, '-node', process.execPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
    await until(async () => {
      if (child.exitCode !== null) throw Error('ProxyKit exited: ' + logs);
      try { return (await fetch(adminOrigin)).status === 200; } catch { return false; }
    }, 15000);
    workerPid = Number(await readFile(join(dataDir, 'lock'), 'utf8'));
    assert.ok(workerPid > 0);
    await assert.rejects(exec('flock', ['-n', ownerLock, 'true']), { code: 1 });
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 7000);
    const [code, signal] = await exited; clearTimeout(kill);
    assert.equal(signal, null, logs); assert.equal(code, 0, logs);
    await assert.rejects(access(join(dataDir, 'lock')));
    await assert.rejects(access(`/proc/${workerPid}`));
    for (const url of [adminOrigin, publicOrigin, origin]) await assert.rejects(fetch(url));
    await exec('flock', ['-n', ownerLock, 'true']); // OS lock released, not merely a surviving lock-file inode.
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
  // Unrelated live publication must not rerun stateful broker setup or rebind either listener.
  const resources = async () => {
    const pid = Number(await readFile(join(dataDir, 'lock'), 'utf8'));
    const entries = (await readFile('/proc/net/tcp', 'utf8')).trim().split('\n').slice(1).map(line => line.trim().split(/\s+/));
    const ports = [adminPort, publicPort].map(p => p.toString(16).toUpperCase().padStart(4, '0'));
    const listeners = entries.filter(e => e[3] === '0A' && ports.includes(e[1].split(':')[1])).map(e => e[9]).sort();
    assert.equal(listeners.length, 2);
    const fds = await Promise.all((await readdir(`/proc/${pid}/fd`)).map(fd => readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')));
    for (const inode of listeners) assert.ok(fds.includes(`socket:[${inode}]`), 'broker owns both listener sockets');
    await assert.rejects(exec('flock', ['-n', ownerLock, 'true']), { code: 1 });
    return { pid, listeners, lock: (await stat(join(dataDir, 'lock'))).ino, ownerLock: (await stat(ownerLock)).ino };
  };
  const originalResources = await resources();
  const headerProbe = async enabled => {
    const probe = await request('/v1/models', scoped);
    assert.equal(probe.status, 200); assert.equal(probe.headers.get('x-activation-fixture'), enabled ? 'enabled' : null);
    await probe.text();
  };
  await headerProbe(false);
  for (const enabled of [true, false]) {
    const beforeActivation = JSON.parse((await admin.request('/api/status')).text);
    await exec(binary, ['extension', enabled ? 'enable' : 'disable', 'activation-fixture'], { env });
    assert.deepEqual(await resources(), originalResources, 'same worker, listener sockets and locks');
    const session = await admin.request('/api/status');
    assert.equal(session.status, 200, 'same authenticated in-memory admin session');
    const afterActivation = JSON.parse(session.text);
    assert.deepEqual(afterActivation.accounts, beforeActivation.accounts, 'account and pulse state unchanged');
    assert.deepEqual(afterActivation.pulseSettings, beforeActivation.pulseSettings);
    assert.equal((await fetch(publicOrigin)).status, 200);
    await headerProbe(enabled);
  }
  t.diagnostic('Unrelated live enable/disable: header toggles; broker PID, both listener sockets, locks, admin session and account/pulse state preserved.');
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
  const durable = await readFile(join(dataDir, 'state.json')), configBytes = await readFile(configPath);
  await exec(binary, ['extension', 'disable', 'broker-proxy'], { env });
  await exec(binary, ['extension', 'remove', 'broker-proxy'], { env });
  assert.deepEqual(await readFile(join(dataDir, 'state.json')), durable);
  assert.deepEqual(await readFile(configPath), configBytes);
  assert.deepEqual(await readFile(join(hostDir, 'secrets.json')), secretBytes);
  await exec(binary, ['extension', 'install', `https://github.com/NotRllyRn/broker-proxy/tree/${ref}`, '--trust'], { env });
  await exec(binary, ['extension', 'enable', 'broker-proxy'], { env });
  await start();
  assert.equal((await request('/v1/models', scoped)).status, 503, 'disabled account survives reinstall');
  await stop();
  const retainedState = await readFile(join(dataDir, 'state.json'));
  // Explicit legacy config and external state win; no implicit copying/migration by the application.
  const hostStateDir = dataDir;
  dataDir = join(dir, 'legacy-data'); await cp(hostStateDir, dataDir, { recursive: true });
  env.BROKER_CONFIG = join(dir, 'legacy-config.json');
  await writeFile(env.BROKER_CONFIG, JSON.stringify({ ...JSON.parse(configBytes), dataDir }), { mode: 0o600 });
  await start();
  assert.equal((await request('/v1/models', scoped)).status, 503);
  await assert.rejects(access(join(hostStateDir, 'lock')));
  await stop();
  assert.deepEqual(await readFile(configPath), configBytes);
  assert.deepEqual(await readFile(join(hostStateDir, 'state.json')), retainedState, 'legacy override leaves host state untouched');
  assert.equal((await stat(hostDir)).mode & 0o7777, 0o700);
  assert.deepEqual(await readFile(join(hostDir, 'secrets.json')), secretBytes);
  for (const secret of Object.values(secrets)) assert.ok(!logs.includes(secret));
  delete env.BROKER_CONFIG;
  // Installed setup must refuse unsafe/partial files before acquiring application resources.
  const secretPath = join(hostDir, 'secrets.json'), marker = join(hostDir, '.initializing');
  for (const scenario of ['unsafe', 'partial']) {
    if (scenario === 'unsafe') await chmod(secretPath, 0o644);
    else await writeFile(marker, '', { mode: 0o600 });
    try {
      await assert.rejects(exec(binary, ['-listen', '127.0.0.1:0', '-upstream', 'http://127.0.0.1:1'], { env, timeout: 15000 }), e => {
        assert.match(e.stderr, scenario === 'unsafe' ? /UNSAFE_INIT_FILE/ : /BROKER_INIT_IN_PROGRESS_OR_INCOMPLETE/);
        assert.equal(e.killed, false);
        for (const secret of Object.values(secrets)) assert.ok(!(e.stdout + e.stderr).includes(secret));
        return true;
      });
      await assert.rejects(access(join(hostStateDir, 'lock')));
      assert.deepEqual(await readFile(secretPath), secretBytes);
      assert.deepEqual(await readFile(configPath), configBytes);
      assert.deepEqual(await readFile(join(hostStateDir, 'state.json')), retainedState);
    } finally {
      if (scenario === 'unsafe') await chmod(secretPath, 0o600); else await rm(marker);
    }
  }
  t.diagnostic(`Verified actual GitHub CLI install at ${ref}; automatic host init/no BROKER_CONFIG, two actual-default boots plus four fixture/legacy boots, removal/reinstall retention and explicit external legacy override; declared trailers rejected, opaque SSE, cancellation, scoped credentials, managed safe-method fallback; manual/background pulses/settings/stats, restart and final process/listener/lock cleanup. Only unrelated header installation uses controlled archive transport; upstream/app-server are synthetic, not live-provider verification.`);
});
