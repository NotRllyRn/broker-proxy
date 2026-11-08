// Provision a NEW private single-instance directory; never imports existing accounts.
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Store } from '../build/store.mjs';
import { Broker } from '../build/broker.mjs';
import { token, digest } from '../build/model.mjs';
const dir = process.argv[2];
if (!dir || !isAbsolute(dir)) throw new Error('Usage: node scripts/init.mjs /absolute/new/private-directory');
await mkdir(dir, { mode: 0o700 }); // Refuse an existing directory rather than overwrite configuration/secrets.
const admin = token(), caller = token();
await writeFile(join(dir, 'secrets.json'), JSON.stringify({ admin, caller }, null, 2), { flag: 'wx', mode: 0o600 });
const broker = new Broker(await Store.open(join(dir, 'data')), { close: async () => {} }, []);
try { await broker.addCaller('Work laptop', caller, [], []); } finally { await broker.close(); }
await writeFile(join(dir, 'config.json'), JSON.stringify({ dataDir: join(dir, 'data'), adminHash: digest(admin),
  dashboard: { host: '127.0.0.1', port: 8788 }, enrollment: { host: '127.0.0.1', port: 8789 },
  enrollmentLabels: ['Personal usage'], codexCommand: 'codex', upstream: 'https://chatgpt.com/backend-api/codex',
  pollMs: 90000, safeFallback: false }, null, 2), { flag: 'wx', mode: 0o600 });
console.log(`Configuration: ${join(dir, 'config.json')}\nRead the generated credentials privately from ${join(dir, 'secrets.json')}; do not paste them into chat or commit them.\nNo accounts were enrolled. Provider compatibility remains live-unverified.`);
