import { mkdir, readFile, open, rename, unlink, chmod, lstat, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { emptyState, Fault, object, credential, labels, text, type State } from './model.mjs';

function validate(value: unknown): State {
  const s = object(value);
  if (s.version !== 1 || !Array.isArray(s.accounts) || !Array.isArray(s.callers) || !Array.isArray(s.exclusions) || !Array.isArray(s.history)
    || s.accounts.length > 1000 || s.callers.length > 1000 || s.history.length > 200) throw new Fault('INVALID_STATE');
  const state = s as unknown as State;
  const ids = new Set<string>();
  for (const a of state.accounts) {
    text(a.id); text(a.label); labels(a.labels);
    if (ids.has(a.id) || typeof a.enabled !== 'boolean' || !['verified', 'refreshing', 'required'].includes(a.authState)
      || !Number.isFinite(a.createdAt) || !a.credential || typeof a.identity !== 'string') throw new Fault('INVALID_STATE');
    ids.add(a.id);
    const c = credential(a.credential.auth, 0);
    if (c.accessToken !== a.credential.accessToken || c.accountId !== a.credential.accountId || c.expiresAt !== a.credential.expiresAt) throw new Fault('INVALID_STATE');
    if (a.quota) for (const w of [a.quota.short, a.quota.weekly]) {
      if (!w || !Number.isFinite(w.used) || w.used < 0 || w.used > 100 || w.reset !== null && !Number.isFinite(w.reset)) throw new Fault('INVALID_STATE');
    }
    if (a.blockedAt !== null && !Number.isFinite(a.blockedAt)) throw new Fault('INVALID_STATE');
  }
  ids.clear();
  for (const c of state.callers) {
    text(c.id); text(c.label); labels(c.allow); labels(c.block);
    if (ids.has(c.id) || !/^[a-f0-9]{64}$/.test(c.digest) || typeof c.enabled !== 'boolean') throw new Fault('INVALID_STATE');
    ids.add(c.id);
  }
  for (const n of Object.values(object(state.counters))) if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Fault('INVALID_STATE');
  for (const e of state.exclusions) if (!Number.isFinite(e.until) || typeof e.caller !== 'string' || typeof e.account !== 'string') throw new Fault('INVALID_STATE');
  return state;
}

export class Store {
  private state: State = emptyState();
  private tail: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private closed = false;
  private constructor(readonly dir: string, private lock: Awaited<ReturnType<typeof open>>) {}
  static async open(dir: string): Promise<Store> {
    dir = resolve(dir);
    const first = await mkdir(dir, { recursive: true, mode: 0o700 });
    if (first) {
      for (let path = dir; ; path = dirname(path)) {
        const parent = await open(dirname(path), 'r');
        try { await parent.sync(); } finally { await parent.close(); }
        if (path === first || path === dirname(path)) break;
      }
    }
    if ((await lstat(dir)).isSymbolicLink()) throw new Fault('UNSAFE_STATE_DIRECTORY');
    await chmod(dir, 0o700);
    // Explicit stale-lock recovery is safer than PID reuse guesses.
    const lock = await open(join(dir, 'lock'), 'wx', 0o600).catch(() => { throw new Fault('STATE_LOCKED'); });
    const store = new Store(dir, lock);
    try {
      await lock.writeFile(String(process.pid));
      try {
        const path = join(dir, 'state.json');
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Fault('INVALID_STATE');
        await chmod(path, 0o600);
        store.state = validate(JSON.parse(await readFile(path, 'utf8')));
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Fault('INVALID_STATE'); }
      await store.change(s => { for (const a of s.accounts) if (a.authState === 'refreshing') { a.authState = 'required'; a.lastError = 'INTERRUPTED_REFRESH'; } });
      // This directory is exclusively extension-owned; never point it at an existing Codex home.
      await rm(join(dir, 'runtimes'), { recursive: true, force: true });
      return store;
    } catch (e) { await store.close(); throw e; }
  }
  snapshot(): State {
    if (this.poisoned || this.closed) throw new Fault('STORE_UNAVAILABLE');
    return structuredClone(this.state);
  }
  change<T>(fn: (next: State) => T): Promise<T> {
    const run = this.tail.then(async () => {
      if (this.poisoned || this.closed) throw new Fault('STORE_UNAVAILABLE');
      const next = structuredClone(this.state), result = fn(next);
      const path = join(this.dir, 'state.next');
      try {
        const file = await open(path, 'w', 0o600);
        try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
        await rename(path, join(this.dir, 'state.json'));
        const directory = await open(this.dir, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } catch { this.poisoned = true; throw new Fault('PERSISTENCE_FAILED'); }
      this.state = next;
      return result;
    });
    this.tail = run.catch(() => {});
    return run;
  }
  async close() {
    await this.tail;
    if (this.closed) return;
    this.closed = true;
    await this.lock.close();
    await unlink(join(this.dir, 'lock'));
  }
}
