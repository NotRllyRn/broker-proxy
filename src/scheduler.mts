import { Fault, type Account, type Quota } from './model.mjs';

export const RESET_GRACE = 45000;
export const RETRY_MIN = 300000;
export const windows = ['short', 'weekly'] as const;
export type Targets = { short: number | null; weekly: number | null };
export type PulseSettings = { enabled: boolean; short: boolean; weekly: boolean; spacingMs: number };
export const defaultSettings = (): PulseSettings => ({ enabled: false, short: true, weekly: true, spacingMs: 60000 });
export type PulseState = {
  initialized: boolean; targets: Targets; handled: Targets; nextAttemptAt: number; failures: number; needsConfirmation: boolean;
  last?: { at: number; finishedAt?: number; status: 'preparing' | 'running' | 'completed' | 'failed' | 'uncertain' | 'skipped'; code?: string; model?: string; automatic: boolean };
};
export const emptyPulse = (): PulseState => ({ initialized: false, targets: { short: null, weekly: null }, handled: { short: null, weekly: null }, nextAttemptAt: 0, failures: 0, needsConfirmation: false });
export function settings(value: PulseSettings): PulseSettings {
  if (typeof value.enabled !== 'boolean' || typeof value.short !== 'boolean' || typeof value.weekly !== 'boolean'
    || !Number.isSafeInteger(value.spacingMs) || value.spacingMs < 15000 || value.spacingMs > 86400000 || value.enabled && !value.short && !value.weekly) throw new Fault('INVALID_PULSE_SETTINGS', 400);
  return { enabled: value.enabled, short: value.short, weekly: value.weekly, spacingMs: value.spacingMs };
}
// Keep an already-due reset even when a read during grace reports the next window.
export function trackResets(a: Account, now: number) {
  const p = a.pulse ??= emptyPulse();
  for (const key of windows) {
    const reset = a.quota?.[key].reset;
    if (reset && reset > (p.handled[key] ?? 0) && (!p.targets[key] || p.targets[key]! > now || p.targets[key]! <= (p.handled[key] ?? 0))) p.targets[key] = reset;
  }
}
export function pulseDue(a: Account, config: PulseSettings, now: number): number | null {
  const p = a.pulse ?? emptyPulse();
  if (!a.enabled || a.authState !== 'verified') return null;
  if (p.needsConfirmation) return Math.max(p.nextAttemptAt, (p.last?.at ?? now) + RESET_GRACE);
  if (!config.enabled) return null;
  if (!p.initialized) return p.nextAttemptAt;
  const due = windows.filter(k => config[k] && p.targets[k] && p.targets[k]! > (p.handled[k] ?? 0)).map(k => p.targets[k]! + RESET_GRACE);
  return due.length ? Math.max(p.nextAttemptAt, Math.min(...due)) : null;
}
export function dueTargets(a: Account, config: PulseSettings, now: number): Targets {
  const p = a.pulse ?? emptyPulse();
  return Object.fromEntries(windows.map(k => [k, config[k] && p.targets[k] && p.targets[k]! + RESET_GRACE <= now && p.targets[k]! > (p.handled[k] ?? 0) ? p.targets[k] : null])) as Targets;
}
export function confirms(q: Quota | null, targets: Targets, now: number): boolean {
  return !!q && windows.every(k => q[k].reset !== null && q[k].reset! > now
    && (!targets[k] || q.startedAt >= targets[k]! + RESET_GRACE && q[k].reset! > targets[k]!));
}
export function consume(a: Account, targets: Targets) {
  const p = a.pulse ??= emptyPulse(); p.initialized = true;
  for (const k of windows) if (targets[k]) p.handled[k] = Math.max(p.handled[k] ?? 0, targets[k]!);
}
export function backoff(p: PulseState, now: number) {
  p.failures = Math.min(p.failures + 1, 5);
  p.nextAttemptAt = now + Math.min(3600000, RETRY_MIN * 2 ** (p.failures - 1));
}
export function confirmObservation(a: Account, q: Quota | null) {
  const p = a.pulse;
  if (p?.needsConfirmation && q && q.startedAt >= (p.last?.at ?? Infinity) + RESET_GRACE) p.needsConfirmation = false;
}
