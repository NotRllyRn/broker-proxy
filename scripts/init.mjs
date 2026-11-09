// Optional external-directory provisioning; normal installed setup initializes automatically.
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, dirname, resolve } from 'node:path';
import { initialize } from '../build/initialize.mjs';
const dir = process.argv[2];
if (!dir || !isAbsolute(dir)) throw new Error('Usage: node scripts/init.mjs /absolute/empty/private-directory');
if (await realpath(dirname(dir)) !== resolve(dirname(dir))) throw new Error('UNSAFE_INIT_DIRECTORY');
await mkdir(dir, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
await initialize(dir);
console.log(`Configuration: ${join(dir, 'config.json')}\nRead the generated credentials privately from ${join(dir, 'secrets.json')}; do not paste them into chat or commit them.\nNo accounts were enrolled. Provider compatibility remains live-unverified.`);
