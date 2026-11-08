import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Fault, object, credential, type Credential } from './model.mjs';

export type Device = { loginId: string; url: string; code: string; expiresAt?: number };
export type ProviderResult = { credential: Credential; identity: string; usage: unknown };
export interface Provider {
  login(signal: AbortSignal, waiting: (device: Device) => void): Promise<ProviderResult>;
  refresh(saved: Credential, signal: AbortSignal): Promise<ProviderResult>;
  close(): Promise<void>;
}
class Runtime {
  private next = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private notify: ((method: string, params: unknown) => void) | undefined;
  private failed: Error | undefined;
  private closed: Promise<void>;
  readonly child: ChildProcessWithoutNullStreams;
  loginId: string | undefined;
  constructor(command: string, readonly home: string, signal: AbortSignal) {
    this.child = spawn(command, ['app-server'], { cwd: home, env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CODEX_HOME: home,
      TMPDIR: join(home, 'tmp'), LANG: 'C.UTF-8',
    }, stdio: 'pipe' });
    this.closed = new Promise(resolve => this.child.once('close', () => { this.fail(new Fault('PROVIDER_EXITED')); resolve(); }));
    this.child.once('error', () => this.fail(new Fault('PROVIDER_UNAVAILABLE')));
    this.child.stdin.on('error', () => this.fail(new Fault('PROVIDER_EXITED')));
    this.child.stderr.resume(); // Never forward provider diagnostics: they may include credentials.
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) { this.fail(new Fault('PROVIDER_FRAME_LIMIT')); this.child.kill('SIGKILL'); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const msg = object(JSON.parse(line));
          if (typeof msg.id === 'number') {
            const p = this.pending.get(msg.id);
            if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); msg.error ? p.reject(new Fault('PROVIDER_RPC_FAILED')) : p.resolve(msg.result); }
          } else if (typeof msg.method === 'string') this.notify?.(msg.method, msg.params);
        } catch { this.fail(new Fault('PROVIDER_PROTOCOL_ERROR')); this.child.kill('SIGKILL'); }
      }
    });
    const abort = () => {
      if (this.loginId && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify({ id: ++this.next, method: 'account/login/cancel', params: { loginId: this.loginId } }) + '\n');
      this.fail(new Fault('CANCELLED', 499)); this.child.kill('SIGTERM');
    };
    signal.addEventListener('abort', abort, { once: true });
    this.closed.then(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  }
  private fail(error: Error) {
    this.failed ??= error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.notify?.('broker/error', null);
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Fault('PROVIDER_TIMEOUT')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'broker_proxy', title: 'Broker Proxy', version: '0.1.0' } });
    this.child.stdin.write('{"method":"initialized"}\n');
  }
  completion(signal: AbortSignal): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Fault('CANCELLED', 499));
      signal.addEventListener('abort', abort, { once: true });
      this.notify = (method, params) => {
        if (method === 'account/login/completed' || method === 'broker/error') {
          signal.removeEventListener('abort', abort);
          this.notify = undefined;
          if (method === 'broker/error') reject(this.failed);
          else { try { resolve(object(params)); } catch { reject(new Fault('PROVIDER_PROTOCOL_ERROR')); } }
        }
      };
      if (signal.aborted) abort();
    });
  }
  async stop() {
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 500);
    try { await this.closed; } finally { clearTimeout(timer); }
  }
}

export class CodexProvider implements Provider {
  private active = new Set<Runtime>();
  private stopped = false;
  private shutdown = new AbortController();
  private operations = new Set<Promise<ProviderResult>>();
  constructor(private dir: string, private command: string, private max = 4) {}
  private async run(signal: AbortSignal, saved: Credential | null, waiting?: (device: Device) => void): Promise<ProviderResult> {
    if (this.stopped || signal.aborted) throw new Fault('CANCELLED', 499);
    // Reserve before the first await to bound concurrent creation too.
    // Public device logins leave one slot for credential refresh (when capacity permits).
    if (this.reserved >= (saved ? this.max : Math.max(1, this.max - 1))) throw new Fault('PROVIDER_BUSY', 429);
    this.reserved++;
    let home: string | undefined, runtime: Runtime | undefined, loginTimer: NodeJS.Timeout | undefined;
    const expiry = new AbortController();
    signal = AbortSignal.any([signal, expiry.signal]);
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      home = await mkdtemp(join(this.dir, 'run-'));
      await mkdir(join(home, 'tmp'), { mode: 0o700 });
      if (saved) await writeFile(join(home, 'auth.json'), JSON.stringify(saved.auth), { mode: 0o600 });
      if (this.stopped || signal.aborted) throw new Fault('CANCELLED', 499);
      runtime = new Runtime(this.command, home, signal); this.active.add(runtime);
      await runtime.initialize();
      if (!saved) {
        const completed = runtime.completion(signal);
        completed.catch(() => {});
        const start = object(await runtime.request('account/login/start', { type: 'chatgptDeviceCode' }));
        if (typeof start.loginId !== 'string' || typeof start.verificationUrl !== 'string' || typeof start.userCode !== 'string') throw new Fault('PROVIDER_PROTOCOL_ERROR');
        runtime.loginId = start.loginId;
        const url = new URL(start.verificationUrl);
        if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.port || url.username || url.password || start.userCode.length > 128) throw new Fault('UNSAFE_PROVIDER_URL');
        const expiresAt = typeof start.expiresAt === 'number' && Number.isFinite(start.expiresAt) ? Math.min(start.expiresAt, Date.now() + 600000) : Date.now() + 600000;
        if (expiresAt <= Date.now()) throw new Fault('LOGIN_EXPIRED', 400);
        loginTimer = setTimeout(() => expiry.abort(), expiresAt - Date.now());
        waiting?.({ loginId: start.loginId, url: url.href, code: start.userCode, expiresAt });
        const result = await completed;
        clearTimeout(loginTimer);
        if (result.loginId !== start.loginId || result.success !== true) throw new Fault('LOGIN_FAILED', 400);
      }
      const account = object(object(await runtime.request('account/read', { refreshToken: !!saved })).account);
      if (account.type !== 'chatgpt' || typeof account.email !== 'string' || !account.email.trim()) throw new Fault('UNSUPPORTED_ACCOUNT');
      let usage: unknown = null;
      try { usage = await runtime.request('account/rateLimits/read', {}); } catch { /* Credential success does not imply quota is known. */ }
      await runtime.stop();
      if (this.stopped || signal.aborted) throw new Fault('CANCELLED', 499);
      const raw = await readFile(join(home, 'auth.json'));
      if (raw.length > 256 * 1024) throw new Fault('INVALID_CREDENTIAL');
      return { credential: credential(JSON.parse(raw.toString())), identity: account.email.trim().toLowerCase(), usage };
    } catch (e) { throw expiry.signal.aborted ? new Fault('LOGIN_EXPIRED', 400) : e instanceof Fault ? e : new Fault('PROVIDER_FAILED'); }
    finally {
      clearTimeout(loginTimer);
      if (runtime) { await runtime.stop(); this.active.delete(runtime); }
      if (home) await rm(home, { recursive: true, force: true });
      this.reserved--;
    }
  }
  private reserved = 0;
  private operation(signal: AbortSignal, saved: Credential | null, waiting?: (device: Device) => void) {
    const work = this.run(AbortSignal.any([signal, this.shutdown.signal]), saved, waiting);
    this.operations.add(work);
    work.then(() => this.operations.delete(work), () => this.operations.delete(work));
    return work;
  }
  login(signal: AbortSignal, waiting: (device: Device) => void) { return this.operation(signal, null, waiting); }
  refresh(saved: Credential, signal: AbortSignal) { return this.operation(signal, saved); }
  async close() {
    this.stopped = true; this.shutdown.abort();
    await Promise.all([...this.active].map(r => r.stop()));
    await Promise.allSettled([...this.operations]);
  }
}
