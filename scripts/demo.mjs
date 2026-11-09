// Local fixture demonstration. No real provider, credentials, or external deployment.
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../build/store.mjs';
import { Broker } from '../build/broker.mjs';
import { digest } from '../build/model.mjs';
import { normalizeUsage } from '../build/policy.mjs';
import { initialize } from '../build/initialize.mjs';
import { auth, usage, fixtureCommand } from '../test/helpers.mjs';
const exec = promisify(execFile);
const binary = process.env.PROXYKIT_BINARY || '/tmp/broker-proxy-proxykit';
const dir = process.env.BROKER_DEMO_DIR ? resolve(process.env.BROKER_DEMO_DIR) : await mkdtemp(join(tmpdir(), 'broker-proxy-demo-'));
await mkdir(dir, { recursive: true, mode: 0o700 });
const dataPort = Number(process.env.BROKER_DEMO_PROXY_PORT || 8080), adminPort = Number(process.env.BROKER_DEMO_ADMIN_PORT || 8788);
const publicPort = Number(process.env.BROKER_DEMO_ENROLLMENT_PORT || 8789), upstreamPort = Number(process.env.BROKER_DEMO_UPSTREAM_PORT || 8790);
const ref = process.env.BROKER_TEST_REF || (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
const extensions = join(dir, 'extensions');
const env = { ...process.env, PROXYKIT_EXTENSIONS_DIR: extensions };
delete env.BROKER_CONFIG;
const installation = await readFile(join(extensions, 'broker-proxy', 'installation.json'), 'utf8').catch(e => { if (e.code !== 'ENOENT') throw e; });
if (installation) {
  if (JSON.parse(installation).commit !== ref) throw new Error('Demo revision changed: use a new BROKER_DEMO_DIR or explicitly disable/remove/reinstall the package.');
} else await exec(binary, ['extension', 'install', `https://github.com/NotRllyRn/broker-proxy/tree/${ref}`, '--trust'], { env });
// Explicit fixture preparation in the install-created directory, not the normal user bootstrap.
const hostDir = join(extensions, '.data', 'broker-proxy');
const configPath = join(hostDir, 'config.json'), dataDir = join(hostDir, 'data');
await initialize(hostDir, true);
const store = await Store.open(dataDir);
const broker = new Broker(store, { close: async () => {} }, ['Personal usage']);
try {
  if (!store.snapshot().callers.some(c => c.digest === digest('fixture-demo-caller-012345678901234567890'))) await broker.addCaller('Work laptop', 'fixture-demo-caller-012345678901234567890', [], []);
  if (!store.snapshot().accounts.length) {
    await broker.importAccount('Personal usage', ['Personal usage'], auth('demo-initial'));
    await store.change(s => { s.accounts[0].quota = normalizeUsage(usage(), Date.now(), Date.now()); });
  }
} finally { await broker.close(); }
await writeFile(configPath, JSON.stringify({ dataDir, adminHash: digest('fixture-demo-admin'),
  dashboard: { port: adminPort }, enrollment: { port: publicPort }, upstream: `http://127.0.0.1:${upstreamPort}/backend`,
  codexCommand: await fixtureCommand(dir, 'slow'), pollMs: 0, safeFallback: true }, null, 2), { mode: 0o600 });
const upstream = createServer(async (req, res) => {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
  if (Buffer.concat(chunks).toString().includes('"stream":true')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"type":"response.output_text.delta","delta":"Local fixture only."}\n\ndata: [DONE]\n\n');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ fixture: true, message: 'Local upstream reached through ProxyKit.', account: req.headers['chatgpt-account-id'] }));
  }
});
let child;
try {
  await exec(binary, ['extension', 'enable', 'broker-proxy'], { env }); // Offline persisted intent; install alone is disabled.
  await new Promise((resolve, reject) => upstream.once('error', reject).listen(upstreamPort, '127.0.0.1', resolve));
  child = spawn(binary, ['-listen', `127.0.0.1:${dataPort}`, '-upstream', `http://127.0.0.1:${upstreamPort}`, '-node', process.execPath], { env, stdio: 'inherit' });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  console.log(`FIXTURE ONLY — no live provider login.\nDashboard: http://127.0.0.1:${adminPort} (secret: fixture-demo-admin)\nEnrollment: http://127.0.0.1:${publicPort} (auto-completes; do not enter fixture code at OpenAI)\nData: http://127.0.0.1:${dataPort}/v1/responses\nCaller: fixture-demo-caller-012345678901234567890\nDurable fixture state: ${dir}\nCtrl-C stops listeners. Reuse with BROKER_DEMO_DIR=${dir} npm run demo.`);
  const [code] = await once(child, 'exit'); process.exitCode = code ?? 1;
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
} finally {
  upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
  // Retain host-owned storage and installed code for explicit demo restart.
}
