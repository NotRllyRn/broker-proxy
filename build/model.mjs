import { createHash, randomBytes } from 'node:crypto';
export class Fault extends Error {
    code;
    status;
    constructor(code, status = 503) {
        super(code);
        this.code = code;
        this.status = status;
    }
}
export const token = () => randomBytes(32).toString('base64url');
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const emptyState = () => ({ version: 1, accounts: [], callers: [], exclusions: [], history: [], counters: { selected: 0, responses: 0, errors: 0, bytes: 0 } });
export const object = (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        throw new Fault('INVALID_OBJECT', 400);
    return v;
};
export function text(v, max = 120) {
    if (typeof v !== 'string' || !v.trim() || v.length > max || /[\x00-\x1f\x7f]/.test(v))
        throw new Fault('INVALID_TEXT', 400);
    return v.trim();
}
export function labels(v) {
    if (!Array.isArray(v) || v.length > 32)
        throw new Fault('INVALID_LABELS', 400);
    return [...new Set(v.map(x => text(x, 60)))];
}
export function credential(auth, now = Date.now()) {
    const raw = object(auth), tokens = object(raw.tokens);
    const accessToken = text(tokens.access_token, 32768);
    let claims;
    try {
        claims = object(JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString()));
    }
    catch {
        throw new Fault('INVALID_CREDENTIAL', 400);
    }
    const expiresAt = Number(claims.exp) * 1000;
    const accountId = text(object(claims['https://api.openai.com/auth']).chatgpt_account_id, 256);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now)
        throw new Fault('EXPIRED_CREDENTIAL', 400);
    // Claims are parsed only from an operator import or provider-created auth file, never used to authenticate callers.
    return { auth: raw, accessToken, accountId, expiresAt };
}
export function publicAccount(a) {
    return { id: a.id, label: a.label, labels: a.labels, enabled: a.enabled, authState: a.authState,
        quota: a.quota, blocked: a.blockedAt !== null, lastError: a.lastError };
}
