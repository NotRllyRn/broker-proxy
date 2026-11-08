import { createHash, randomBytes } from 'node:crypto';
import { defaultSettings, type PulseSettings, type PulseState } from './scheduler.mjs';

export class Fault extends Error {
  constructor(public code: string, public status = 503) { super(code); }
}
export const token = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export type Credential = { auth: Record<string, unknown>; accessToken: string; accountId: string; expiresAt: number };
export type Window = { used: number; reset: number | null; durationMinutes?: number };
export type Quota = { short: Window; weekly: Window; observedAt: number; startedAt: number };
export type Account = {
  id: string; label: string; labels: string[]; enabled: boolean;
  authState: 'verified' | 'refreshing' | 'required'; createdAt: number;
  credential: Credential; generation: string; identity: string; quota: Quota | null;
  blockedAt: number | null; lastError: string | null;
  pulse?: PulseState;
  usageStatus?: { at: number; status: 'complete' | 'incomplete' | 'failed'; code?: string };
  stats?: { selected: number; responses: number; errors: number };
};
export type Caller = { id: string; label: string; digest: string; enabled: boolean; allow: string[]; block: string[] };
export type History = { at: number; exchange: string; attempt: number; caller: string; account: string };
export type State = {
  version: 1; accounts: Account[]; callers: Caller[];
  pulseSettings: PulseSettings; scheduler: { nextAt: number; nextRegularAt: number; cursor: number };
  exclusions: { caller: string; account: string; until: number }[];
  history: History[]; counters: { selected: number; responses: number; errors: number; bytes: number };
};
export const emptyState = (): State => ({ version: 1, accounts: [], callers: [], pulseSettings: defaultSettings(), scheduler: { nextAt: 0, nextRegularAt: 0, cursor: 0 }, exclusions: [], history: [], counters: { selected: 0, responses: 0, errors: 0, bytes: 0 } });
export const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Fault('INVALID_OBJECT', 400);
  return v as Record<string, unknown>;
};
export function text(v: unknown, max = 120): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\x00-\x1f\x7f]/.test(v)) throw new Fault('INVALID_TEXT', 400);
  return v.trim();
}
export function labels(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 32) throw new Fault('INVALID_LABELS', 400);
  return [...new Set(v.map(x => text(x, 60)))];
}
export function credential(auth: unknown, now = Date.now()): Credential {
  const raw = object(auth), tokens = object(raw.tokens);
  const accessToken = text(tokens.access_token, 32768);
  let claims: Record<string, unknown>;
  try { claims = object(JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString())); }
  catch { throw new Fault('INVALID_CREDENTIAL', 400); }
  const expiresAt = Number(claims.exp) * 1000;
  const accountId = text(object(claims['https://api.openai.com/auth']).chatgpt_account_id, 256);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Fault('EXPIRED_CREDENTIAL', 400);
  // Claims are parsed only from an operator import or provider-created auth file, never used to authenticate callers.
  return { auth: raw, accessToken, accountId, expiresAt };
}
export function publicAccount(a: Account) {
  return { id: a.id, label: a.label, labels: a.labels, enabled: a.enabled, authState: a.authState,
    quota: a.quota, blocked: a.blockedAt !== null, lastError: a.lastError, pulse: a.pulse ?? null,
    usageStatus: a.usageStatus ?? null, stats: a.stats ?? { selected: 0, responses: 0, errors: 0 } };
}
