// Opt-in network test. No credentials, device login, account RPCs, or inference calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexInstallation, CODEX_VERSION, installProcess } from '../build/codex-install.mjs';
import { Store } from '../build/store.mjs';
import { temp } from './helpers.mjs';

test('official pinned npm installation, reuse, version, generated contract and isolated app-server initialize (no account)', { timeout: 240000 }, async t => {
  const dir = await temp(), store = await Store.open(join(dir, 'data'));
  const root = join(dir, 'data', 'codex'), manager = new CodexInstallation(root);
  let reopened;
  t.after(async () => { await manager.close(); await reopened?.close(); await store.close(); await rm(dir, { recursive: true, force: true }); });
  const signal = AbortSignal.timeout(220000), command = await manager.prepare(signal);
  const home = join(dir, 'probe'); await mkdir(join(home, 'tmp'), { recursive: true, mode: 0o700 });
  const env = { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: home, TMPDIR: join(home, 'tmp'), LANG: 'C.UTF-8' };
  assert.equal(await installProcess(command, ['--version'], home, env, signal), `codex-cli ${CODEX_VERSION}`);
  await manager.close();
  reopened = new CodexInstallation(root, '/npm-not-required-for-verified-reuse');
  assert.equal(await reopened.prepare(signal), command);
  const schemaDir = join(dir, 'schema');
  await installProcess(command, ['app-server', 'generate-json-schema', '--out', schemaDir], home, env, signal);
  const schema = async name => JSON.parse(await readFile(join(schemaDir, name), 'utf8'));
  const login = await schema('v2/LoginAccountParams.json');
  assert.ok(login.oneOf.some(v => v.properties.type.enum.includes('chatgptDeviceCode')));
  const device = (await schema('v2/LoginAccountResponse.json')).oneOf.find(v => v.properties.type.enum.includes('chatgptDeviceCode'));
  for (const field of ['loginId', 'userCode', 'verificationUrl']) assert.ok(device.required.includes(field));
  assert.equal((await schema('v2/GetAccountParams.json')).properties.refreshToken.type, 'boolean');
  assert.ok((await schema('v2/GetAccountRateLimitsResponse.json')).properties.rateLimitsByLimitId);
  const child = spawn(command, ['app-server'], { cwd: home, env, stdio: 'pipe' });
  const closed = once(child, 'close'); child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  try {
    const initialized = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('initialize timed out')), 15000);
      const finish = () => clearTimeout(timer);
      child.once('error', e => { finish(); reject(e); });
      child.once('close', () => { finish(); reject(Error('app-server exited before initialize')); });
      lines.on('line', line => {
        try { const message = JSON.parse(line); if (message.id === 1) { finish(); resolve(message); } }
        catch (e) { finish(); reject(e); }
      });
    });
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'broker_proxy', title: 'Broker Proxy', version: '0.1.0' } } }) + '\n');
    const response = await initialized;
    assert.equal(response.error, undefined); assert.equal(response.result.codexHome, home);
    assert.ok(response.result.userAgent.includes(CODEX_VERSION));
    child.stdin.write('{"method":"initialized"}\n');
  } finally {
    child.kill('SIGTERM'); const kill = setTimeout(() => child.kill('SIGKILL'), 500);
    try { await closed; } finally { clearTimeout(kill); lines.close(); }
  }
  await assert.rejects(access(join(home, 'auth.json')));
  t.diagnostic(`Verified @openai/codex ${CODEX_VERSION} on ${process.platform}/${process.arch}; npm lock integrity, cache reuse, generated protocol and initialize only. No provider login/refresh/inference verified.`);
});
