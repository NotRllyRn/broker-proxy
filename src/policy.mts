import { object, type Account, type Caller, type Quota, type Window, type State } from './model.mjs';

export function inScope(a: Account, c: Caller): boolean {
  return c.enabled && !c.block.some(x => a.labels.includes(x)) && (!c.allow.length || c.allow.some(x => a.labels.includes(x)));
}
export const exhausted = (a: Account) => a.blockedAt !== null || !!a.quota && (a.quota.short.used >= 100 || a.quota.weekly.used >= 100);
const future = (value: number | null | undefined, now: number) => value && value > now ? value : Infinity;
export function rank(a: Account, b: Account, preferred: string, now: number): number {
  const av = [future(a.quota?.weekly.reset, now), future(a.quota?.short.reset, now), a.id === preferred ? 0 : 1, a.createdAt];
  const bv = [future(b.quota?.weekly.reset, now), future(b.quota?.short.reset, now), b.id === preferred ? 0 : 1, b.createdAt];
  for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return av[i]! < bv[i]! ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
export function candidates(s: State, c: Caller, preferred: string, now: number): Account[] {
  return s.accounts.filter(a => a.enabled && a.authState === 'verified' && inScope(a, c) && !exhausted(a)
    && !s.exclusions.some(e => e.caller === c.id && e.account === a.id && e.until > now))
    .sort((a, b) => rank(a, b, preferred, now));
}
export function accountReset(a: Account, now: number): number {
  return Math.max(0, ...[a.quota?.short, a.quota?.weekly].map(w => w && w.used >= 100 && w.reset && w.reset > now ? w.reset : 0));
}
export function retryAt(s: State, c: Caller, now: number): number | null {
  const times: number[] = [];
  for (const a of s.accounts.filter(a => a.enabled && a.authState === 'verified' && inScope(a, c))) {
    times.push(accountReset(a, now));
    if (a.blockedAt !== null || exhausted(a) && !accountReset(a, now) && (a.quota?.short.reset || a.quota?.weekly.reset)) times.push(now + 45000);
    for (const e of s.exclusions) if (e.account === a.id && e.caller === c.id) times.push(e.until);
  }
  return times.filter(t => t > now).sort((a, b) => a - b)[0] ?? null;
}
export function exclude(s: State, a: Account, caller: string, rateLimit: boolean, now: number) {
  s.exclusions = s.exclusions.filter(e => e.until > now && !(e.account === a.id && e.caller === caller));
  s.exclusions.push({ caller, account: a.id, until: accountReset(a, now) || now + (rateLimit ? 60000 : 300000) });
}
export function normalizeUsage(payload: unknown, startedAt: number, observedAt: number): Quota | null {
  try {
    const p = object(payload);
    const source = object(p.rateLimitsByLimitId && object(p.rateLimitsByLimitId).codex || p.rateLimits || p);
    const raw = Array.isArray(source.windows) && source.windows.length ? source.windows : [source.primary, source.secondary].filter(Boolean);
    const windows = raw.map(x => object(x));
    const valid = (x: Record<string, unknown>) => typeof x.windowDurationMins === 'number' && Number.isFinite(x.windowDurationMins);
    const weeks = windows.filter(x => valid(x) && Math.abs(Number(x.windowDurationMins) - 10080) <= 504);
    const shorts = windows.filter(x => valid(x) && Number(x.windowDurationMins) > 0 && Number(x.windowDurationMins) < 1440)
      .sort((a, b) => Number(a.windowDurationMins) - Number(b.windowDurationMins));
    if (weeks.length !== 1 || !shorts.length || shorts.length > 1 && shorts[0]!.windowDurationMins === shorts[1]!.windowDurationMins) return null;
    const window = (v: Record<string, unknown>): Window => {
      if (typeof v.usedPercent !== 'number' || !Number.isFinite(v.usedPercent) || v.usedPercent < 0 || v.usedPercent > 100) throw Error();
      return { used: v.usedPercent, durationMinutes: Number(v.windowDurationMins), reset: typeof v.resetsAt === 'number' && Number.isSafeInteger(v.resetsAt * 1000) && v.resetsAt > 0 ? v.resetsAt * 1000 : null };
    };
    return { short: window(shorts[0]!), weekly: window(weeks[0]!), startedAt, observedAt };
  } catch { return null; }
}
export function applyQuota(a: Account, q: Quota | null) {
  if (!q || a.quota && (q.observedAt < a.quota.observedAt || q.startedAt < a.quota.startedAt)) return;
  a.quota = q;
  if (a.blockedAt !== null && q.startedAt >= a.blockedAt + 45000) a.blockedAt = null;
}
