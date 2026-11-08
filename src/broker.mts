import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import { Fault, digest, credential, labels, text, publicAccount, type Account, type Caller, type Credential } from './model.mjs';
import { candidates, retryAt, exclude, applyQuota, normalizeUsage, inScope, exhausted } from './policy.mjs';
import { ProviderAdmissionFault, type Provider, type Device } from './provider.mjs';

export type Enrollment = { id: string; state: 'starting' | 'waiting' | 'verifying' | 'completed' | 'failed' | 'cancelled' | 'expired'; expires: number; device?: Device; error?: string };
export class Broker {
  readonly stop = new AbortController();
  private flights = new Map<string, Promise<void>>();
  private enrollments = new Map<string, { view: Enrollment; abort: AbortController; done: Promise<void> }>();
  private timer: NodeJS.Timeout | undefined;
  private pollJob: Promise<void> = Promise.resolve();
  private pollIndex = 0;
  private starts: number[] = [];
  constructor(readonly store: Store, private provider: Provider, private enrollmentLabels: string[], private clock = Date.now) {}
  authenticate(bearer: string): Caller {
    const hashed = digest(bearer);
    const caller = this.store.snapshot().callers.find(c => c.enabled && c.digest === hashed);
    if (!caller) throw new Fault('UNAUTHORIZED', 401);
    return caller;
  }
  async addCaller(label: string, secret: string, allow: string[], block: string[]) {
    if (secret.length < 32 || secret.length > 256) throw new Fault('WEAK_CALLER_SECRET', 400);
    const c: Caller = { id: randomUUID(), label: text(label), digest: digest(secret), enabled: true, allow: labels(allow), block: labels(block) };
    await this.store.change(s => {
      if (s.callers.length >= 1000 || s.callers.some(x => x.digest === c.digest)) throw new Fault('CALLER_EXISTS_OR_LIMIT', 409);
      s.callers.push(c);
    });
    return c.id;
  }
  async setCaller(id: string, enabled: boolean) {
    await this.store.change(s => { const c = s.callers.find(c => c.id === id); if (!c) throw new Fault('NOT_FOUND', 404); c.enabled = enabled; });
  }
  async importAccount(label: string, accountLabels: string[], auth: unknown) {
    const c = credential(auth, this.clock());
    const existing = this.store.snapshot().accounts.find(a => a.credential.accountId === c.accountId);
    if (!existing) return this.activate(text(label), labels(accountLabels), c, '');
    if (this.flights.has(existing.id)) throw new Fault('REFRESH_IN_PROGRESS', 409);
    await this.store.change(s => {
      const a = s.accounts.find(a => a.id === existing.id)!;
      a.credential = c; a.generation = randomUUID(); a.authState = 'verified'; a.lastError = null;
      a.label = text(label); a.labels = labels(accountLabels);
      // Reauthorization does not erase quota blocks, baseline usage, or administrator deactivation.
    });
    return existing.id;
  }
  private async activate(label: string, accountLabels: string[], c: Credential, identity: string, usage?: unknown, startedAt = this.clock(), signal?: AbortSignal) {
    const id = randomUUID(), now = this.clock();
    await this.store.change(s => {
      // Cancellation wins while queued; beginning this transaction is the activation commit boundary.
      if (signal?.aborted) throw new Fault('CANCELLED', 499);
      if (s.accounts.length >= 1000) throw new Fault('ACCOUNT_LIMIT', 409);
      if (s.accounts.some(a => a.credential.accountId === c.accountId || identity && a.identity === identity)) throw new Fault('DUPLICATE_ACCOUNT', 409);
      s.accounts.push({ id, label, labels: accountLabels, enabled: true, authState: 'verified', createdAt: now,
        credential: c, generation: randomUUID(), identity, quota: normalizeUsage(usage, startedAt, now), blockedAt: null, lastError: null });
    });
    return id;
  }
  async setAccount(id: string, enabled?: boolean, accountLabels?: string[]) {
    await this.store.change(s => {
      const a = s.accounts.find(a => a.id === id); if (!a) throw new Fault('NOT_FOUND', 404);
      if (enabled !== undefined) a.enabled = enabled;
      if (accountLabels) a.labels = labels(accountLabels);
    });
  }
  refresh(id: string): Promise<void> {
    if (this.flights.has(id)) return this.flights.get(id)!;
    const work = this.refreshAccount(id).finally(() => this.flights.delete(id));
    this.flights.set(id, work);
    return work;
  }
  private async refreshAccount(id: string) {
    const startedAt = this.clock();
    const signal = AbortSignal.any([this.stop.signal, AbortSignal.timeout(25000)]);
    // Installation cannot rotate credentials: do not persist an ambiguous refresh while waiting for it.
    await this.provider.prepare?.(signal);
    const original = await this.store.change(s => {
      const a = s.accounts.find(a => a.id === id); if (!a) throw new Fault('NOT_FOUND', 404);
      if (a.authState === 'required') throw new Fault('AUTH_REQUIRED', 409);
      a.authState = 'refreshing'; return structuredClone(a.credential);
    });
    try {
      const result = await this.provider.refresh(original, signal);
      if (result.credential.accountId !== original.accountId) throw new Fault('IDENTITY_CHANGED');
      await this.store.change(s => {
        const a = s.accounts.find(a => a.id === id);
        if (!a || a.credential.accessToken !== original.accessToken) throw new Fault('ACCOUNT_CHANGED', 409);
        a.credential = result.credential; a.generation = randomUUID(); a.authState = 'verified'; a.lastError = null;
        applyQuota(a, normalizeUsage(result.usage, startedAt, this.clock()));
      });
    } catch (e) {
      await this.store.change(s => {
        const a = s.accounts.find(a => a.id === id);
        if (!a || a.credential.accessToken !== original.accessToken || a.authState !== 'refreshing') return;
        // Admission rejection cannot have rotated credentials; ambiguous provider failures can.
        const admission = e instanceof ProviderAdmissionFault || e instanceof Fault && e.code === 'PROVIDER_BUSY';
        a.authState = admission ? 'verified' : 'required'; a.lastError = admission ? e.code : 'REFRESH_FAILED';
      });
      throw e instanceof Fault ? e : new Fault('REFRESH_FAILED');
    }
  }
  async select(callerId: string, preferred: string, exchange: string, attempt: number, signal: AbortSignal): Promise<Account> {
    const s = this.store.snapshot(), c = s.callers.find(c => c.id === callerId && c.enabled);
    if (!c) throw new Fault('UNAUTHORIZED', 401);
    for (const a of s.accounts) if (a.authState === 'refreshing' && this.flights.has(a.id)) a.authState = 'verified';
    const selected = candidates(s, c, preferred, this.clock())[0];
    if (!selected) throw new Fault(retryAt(s, c, this.clock()) ? 'POOL_AWAITING_CONFIRMATION' : 'POOL_RESET_UNKNOWN');
    if (this.flights.has(selected.id) || selected.credential.expiresAt <= this.clock() + 300000) await wait(this.refresh(selected.id), signal);
    if (signal.aborted || this.stop.signal.aborted) throw new Fault('CANCELLED', 499);
    return this.store.change(next => {
      const caller = next.callers.find(c => c.id === callerId && c.enabled), a = next.accounts.find(a => a.id === selected.id);
      if (!caller || !a || !a.enabled || a.authState !== 'verified' || !inScope(a, caller) || exhausted(a)
        || a.credential.expiresAt <= this.clock() || next.exclusions.some(e => e.caller === callerId && e.account === a.id && e.until > this.clock())) throw new Fault('ACCOUNT_CHANGED', 409);
      next.history.push({ at: this.clock(), exchange, attempt, caller: callerId, account: a.id });
      next.history = next.history.slice(-200); next.counters.selected++;
      return structuredClone(a);
    });
  }
  async observe(account: string, caller: string, status: number, generation?: string) {
    await this.store.change(s => {
      const a = s.accounts.find(a => a.id === account); if (!a) return;
      s.counters.responses++;
      if (status < 400) return;
      s.counters.errors++;
      if (status === 429) { a.blockedAt = this.clock(); a.lastError = 'QUOTA_OR_RATE_LIMIT'; }
      else if ((status === 401 || status === 403) && generation === a.generation) { a.authState = 'required'; a.lastError = 'UPSTREAM_AUTH_REJECTED'; }
      else if (status >= 500) exclude(s, a, caller, false, this.clock());
    });
  }
  view() {
    const s = this.store.snapshot();
    return { accounts: s.accounts.map(publicAccount), callers: s.callers.map(({ digest: _, ...c }) => c), history: s.history, counters: s.counters };
  }
  startEnrollment(): Enrollment {
    const now = this.clock(); this.prune();
    this.starts = this.starts.filter(t => t > now - 60000);
    if (this.stop.signal.aborted || this.starts.length >= 10 || this.enrollments.size >= 100
      || [...this.enrollments.values()].filter(e => !terminal(e.view.state)).length >= 4) throw new Fault('ENROLLMENT_BUSY', 429);
    this.starts.push(now);
    const id = randomUUID(), abort = new AbortController();
    const view: Enrollment = { id, state: 'starting', expires: now + 600000 };
    const signal = AbortSignal.any([abort.signal, this.stop.signal, AbortSignal.timeout(600000)]);
    const done = (async () => {
      try {
        const result = await this.provider.login(signal, device => { if (!signal.aborted) { view.device = device; view.state = 'waiting'; view.expires = Math.min(view.expires, device.expiresAt ?? view.expires); } });
        if (signal.aborted) throw new Fault('CANCELLED');
        view.state = 'verifying'; delete view.device;
        await this.activate('Example user', this.enrollmentLabels, result.credential, result.identity, result.usage, now, signal);
        view.state = 'completed';
      } catch (e) {
        view.state = abort.signal.aborted ? 'cancelled' : signal.aborted || e instanceof Fault && e.code === 'LOGIN_EXPIRED' ? 'expired' : 'failed';
        view.error = e instanceof Fault && e.code === 'DUPLICATE_ACCOUNT' ? 'DUPLICATE_ACCOUNT' : 'ENROLLMENT_FAILED';
      } finally { delete view.device; }
    })();
    this.enrollments.set(id, { view, abort, done });
    return structuredClone(view);
  }
  enrollment(id: string): Enrollment {
    this.prune(); const e = this.enrollments.get(id);
    if (!e) throw new Fault('SESSION_EXPIRED_OR_RESTARTED', 404);
    const { device, ...view } = e.view;
    return device ? { ...view, device: { ...device, loginId: '' } } : { ...view };
  }
  async cancelEnrollment(id: string) {
    const e = this.enrollments.get(id); if (!e) throw new Fault('NOT_FOUND', 404);
    if (!terminal(e.view.state)) { e.abort.abort(); await e.done; }
  }
  private prune() {
    for (const [id, e] of this.enrollments) if (e.view.expires <= this.clock()) {
      e.abort.abort(); if (terminal(e.view.state)) this.enrollments.delete(id);
    }
  }
  startPolling(interval: number) {
    if (!interval) return;
    const tick = () => { this.timer = setTimeout(() => {
      this.pollJob = (async () => {
        const accounts = this.store.snapshot().accounts.filter(a => a.enabled && a.authState === 'verified');
        if (accounts.length) await this.refresh(accounts[this.pollIndex++ % accounts.length]!.id);
      })().catch(() => {}).finally(() => { if (!this.stop.signal.aborted) tick(); });
    }, interval); };
    tick();
  }
  async close() {
    this.stop.abort(); clearTimeout(this.timer);
    await this.provider.close();
    await Promise.allSettled([...this.flights.values(), ...[...this.enrollments.values()].map(e => e.done), this.pollJob]);
    await this.store.close();
  }
}
const terminal = (state: Enrollment['state']) => ['completed', 'failed', 'cancelled', 'expired'].includes(state);
export function wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Fault('CANCELLED', 499));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
