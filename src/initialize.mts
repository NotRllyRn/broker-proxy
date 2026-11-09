import { lstat, readdir, open, unlink, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { loadConfig, type Config } from './config.mjs';
import { Store, STATE_LIMIT } from './store.mjs';
import { Fault, token, digest } from './model.mjs';
import { randomUUID } from 'node:crypto';

async function privateDirectory(dir: string): Promise<void> {
  // Ancestors must remain trusted against replacement; this is not a same-UID sandbox.
  for (let path = resolve(dir); ; path = dirname(path)) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || path === resolve(dir)
      && (info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700)) throw new Fault('UNSAFE_INIT_DIRECTORY');
    if (path === dirname(path)) break;
  }
}
async function privateFile(path: string, limit: number): Promise<void> {
  const info = await lstat(path).catch(() => { throw new Fault('BROKER_INIT_INCOMPLETE'); });
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o600 || info.nlink !== 1 || info.size > limit)
    throw new Fault('UNSAFE_INIT_FILE');
}
async function syncDirectory(dir: string): Promise<void> {
  const file = await open(dir, 'r');
  try { await file.sync(); } finally { await file.close(); }
}
async function createJSON(path: string, value: unknown): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
}

// Setup may reuse complete initialization. The optional tool refuses all existing contents.
export async function initialize(dir: string | undefined, reuse = false): Promise<Config> {
  if (!dir || !isAbsolute(dir)) throw new Fault('HOST_DATA_DIR_REQUIRED');
  await privateDirectory(dir);
  const names = await readdir(dir), configPath = join(dir, 'config.json'), marker = join(dir, '.initializing');
  if (names.includes('.initializing')) throw new Fault('BROKER_INIT_IN_PROGRESS_OR_INCOMPLETE');
  if (names.length) {
    if (!reuse) throw new Fault('INIT_DIRECTORY_NOT_EMPTY');
    if (!names.includes('config.json')) throw new Fault('BROKER_INIT_INCOMPLETE');
    await privateFile(configPath, 65536);
    const config = await loadConfig(configPath);
    await privateFile(join(dir, 'secrets.json'), 4096);
    const file = await open(join(dir, 'secrets.json'), 'r');
    try {
      const secrets = JSON.parse(await file.readFile('utf8'));
      if (!secrets || !['admin', 'caller'].every(k => typeof secrets[k] === 'string' && /^[A-Za-z0-9_-]{43}$/.test(secrets[k]))) throw new Error();
    } catch { throw new Fault('BROKER_INIT_INCOMPLETE'); } finally { await file.close(); }
    await privateDirectory(config.dataDir);
    await privateFile(join(config.dataDir, 'state.json'), STATE_LIMIT);
    return config; // Store.open still validates the state schema and acquires its separate writer lock.
  }
  const lock = await open(marker, 'wx', 0o600).catch(() => { throw new Fault('BROKER_INIT_IN_PROGRESS_OR_INCOMPLETE'); });
  try { await lock.sync(); } finally { await lock.close(); }
  await syncDirectory(dir);
  // Another initializer may have finished between our empty check and lock acquisition.
  // We have not written application files: release only our marker and revalidate from scratch.
  if ((await readdir(dir)).some(name => name !== '.initializing')) {
    await unlink(marker); await syncDirectory(dir);
    return initialize(dir, reuse);
  }
  const admin = token(), caller = token(), dataDir = join(dir, 'data');
  await createJSON(join(dir, 'secrets.json'), { admin, caller });
  await mkdir(dataDir, { mode: 0o700 });
  const store = await Store.open(dataDir);
  try {
    await store.change(s => { s.callers.push({ id: randomUUID(), label: 'Work laptop', digest: digest(caller), enabled: true, allow: [], block: [] }); });
  } finally { await store.close(); }
  await syncDirectory(dataDir);
  await createJSON(configPath, { dataDir, adminHash: digest(admin),
    dashboard: { host: '127.0.0.1', port: 8788 }, enrollment: { host: '127.0.0.1', port: 8789 },
    enrollmentLabels: ['Personal usage'], upstream: 'https://chatgpt.com/backend-api/codex', pollMs: 90000, safeFallback: false });
  await syncDirectory(dir);
  await unlink(marker); // Only a completely written initialization releases the marker; failures retain evidence.
  await syncDirectory(dir);
  return loadConfig(configPath);
}
