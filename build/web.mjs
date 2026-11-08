import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Fault, digest, token } from './model.mjs';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const page = (title, body) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><style>body{font:16px system-ui;max-width:1050px;margin:3rem auto;padding:0 1rem;color:#17212b}table{border-collapse:collapse;width:100%}td,th{padding:.6rem;text-align:left;border-bottom:1px solid #ddd}label{display:block;margin:.7rem 0}input,textarea,button{font:inherit;padding:.4rem}textarea{width:95%}fieldset{margin:1.2rem 0}small{display:block;color:#53606c}code{font-size:1.1em}a{color:#14529c}</style><h1>${esc(title)}</h1>${body}</html>`;
const form = (action, csrf, content) => `<form method="post" action="${action}"><input type="hidden" name="csrf" value="${csrf}">${content}</form>`;
const field = (name, title, type = 'text') => `<label>${title} <input name="${name}" type="${type}" required autocomplete="off"></label>`;
const list = (value) => (value ?? '').split(',').map(x => x.trim()).filter(Boolean);
class Site {
    broker;
    config;
    publicSite;
    server;
    sessions = new Map();
    loginAttempts = [];
    constructor(broker, config, publicSite) {
        this.broker = broker;
        this.config = config;
        this.publicSite = publicSite;
        this.server = createServer((req, res) => {
            this.handle(req, res).catch(e => {
                if (res.headersSent) {
                    res.destroy();
                    return;
                }
                res.statusCode = e instanceof Fault ? e.status : 500;
                res.end(page('Request could not be completed', `<p>${esc(e instanceof Fault ? e.code : 'INTERNAL_ERROR')}</p><a href="/">Return</a>`));
            });
        });
        this.server.requestTimeout = 10000;
        this.server.headersTimeout = 10000;
        this.server.keepAliveTimeout = 2000;
        this.server.maxHeadersCount = 50;
    }
    session(req, res) {
        const now = Date.now();
        for (const [key, s] of this.sessions)
            if (s.expires <= now)
                this.sessions.delete(key);
        const name = this.publicSite ? 'broker_enrollment' : 'broker_admin';
        const cookie = (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1);
        const old = cookie && this.sessions.get(cookie);
        if (old)
            return old;
        if (this.sessions.size >= 256) {
            const idle = [...this.sessions].find(([, s]) => !s.admin && !s.enrollment);
            if (idle)
                this.sessions.delete(idle[0]);
            else
                throw new Fault('SESSION_LIMIT', 429);
        }
        const id = token(), s = { csrf: token(), expires: now + 3600000, admin: false };
        this.sessions.set(id, s);
        res.setHeader('Set-Cookie', `${name}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600${this.listener.origin.startsWith('https:') ? '; Secure' : ''}`);
        return s;
    }
    get listener() { return this.publicSite ? this.config.enrollment : this.config.dashboard; }
    async handle(req, res) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.headers.host !== new URL(this.listener.origin).host)
            throw new Fault('INVALID_HOST', 403);
        const url = new URL(req.url ?? '/', this.listener.origin);
        const session = this.session(req, res);
        if (req.method === 'POST') {
            if (req.headers.origin !== this.listener.origin)
                throw new Fault('INVALID_ORIGIN', 403);
            if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))
                throw new Fault('FORM_REQUIRED', 415);
            const input = await body(req);
            if (input.get('csrf') !== session.csrf)
                throw new Fault('INVALID_CSRF', 403);
            if (this.publicSite) {
                if (url.pathname === '/start') {
                    if (session.enrollment) {
                        const e = this.broker.enrollment(session.enrollment);
                        if (['starting', 'waiting', 'verifying'].includes(e.state))
                            throw new Fault('ENROLLMENT_IN_PROGRESS', 409);
                    }
                    session.enrollment = this.broker.startEnrollment().id;
                }
                else if (url.pathname === '/cancel' && session.enrollment)
                    await this.broker.cancelEnrollment(session.enrollment);
                else
                    throw new Fault('NOT_FOUND', 404);
            }
            else if (url.pathname === '/login') {
                this.loginAttempts = this.loginAttempts.filter(t => t > Date.now() - 60000);
                if (this.loginAttempts.length >= 10)
                    throw new Fault('LOGIN_RATE_LIMIT', 429);
                this.loginAttempts.push(Date.now());
                if (!timingSafeEqual(Buffer.from(digest(input.get('secret') ?? ''), 'hex'), Buffer.from(this.config.adminHash, 'hex')))
                    throw new Fault('UNAUTHORIZED', 401);
                session.admin = true;
                session.csrf = token();
            }
            else {
                if (!session.admin)
                    throw new Fault('UNAUTHORIZED', 401);
                const get = (key) => input.get(key) ?? '';
                switch (url.pathname) {
                    case '/logout':
                        session.admin = false;
                        session.csrf = token();
                        break;
                    case '/account/import':
                        await this.broker.importAccount(get('label'), list(get('labels')), JSON.parse(get('auth')));
                        break;
                    case '/account/state':
                        await this.broker.setAccount(get('id'), get('enabled') === 'true');
                        break;
                    case '/account/labels':
                        await this.broker.setAccount(get('id'), undefined, list(get('labels')));
                        break;
                    case '/account/refresh':
                        await this.broker.refresh(get('id'));
                        break;
                    case '/caller/add':
                        await this.broker.addCaller(get('label'), get('secret'), list(get('allow')), list(get('block')));
                        break;
                    case '/caller/state':
                        await this.broker.setCaller(get('id'), get('enabled') === 'true');
                        break;
                    default: throw new Fault('NOT_FOUND', 404);
                }
            }
            res.writeHead(303, { Location: '/' });
            res.end();
            return;
        }
        if (req.method !== 'GET')
            throw new Fault('METHOD_NOT_ALLOWED', 405);
        if (this.publicSite) {
            if (!['/', '/status'].includes(url.pathname))
                throw new Fault('NOT_FOUND', 404);
            let enrollment;
            if (session.enrollment) {
                try {
                    enrollment = this.broker.enrollment(session.enrollment);
                }
                catch {
                    delete session.enrollment;
                }
            }
            if (url.pathname === '/status') {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(enrollment ?? { state: 'idle' }));
                return;
            }
            let content = '<p>Authorize a ChatGPT account for this broker. This is provider device login, not a password or token upload.</p>';
            if (enrollment) {
                content += `<p>Status: <strong>${esc(enrollment.state)}</strong></p>`;
                if (enrollment.device)
                    content += `<p>Open <a href="${esc(enrollment.device.url)}" rel="noreferrer" target="_blank">the provider authorization page</a> and enter this code:</p><p><code>${esc(enrollment.device.code)}</code></p>`;
                if (['starting', 'waiting', 'verifying'].includes(enrollment.state)) {
                    res.setHeader('Refresh', '3; url=/');
                    content += `<p>Status refreshes every three seconds. <a href="/">Refresh now</a> (expires ${esc(new Date(enrollment.expires).toISOString())})</p>${form('/cancel', session.csrf, '<button>Cancel enrollment</button>')}`;
                }
                else
                    content += `<p>${esc(enrollment.error ?? 'Enrollment complete. You may close this page.')}</p>`;
            }
            if (!enrollment || ['completed', 'failed', 'cancelled', 'expired'].includes(enrollment.state))
                content += form('/start', session.csrf, '<button>Start device login</button>');
            res.end(page('Enroll an account', content));
            return;
        }
        if (!session.admin) {
            if (url.pathname !== '/')
                throw new Fault('UNAUTHORIZED', 401);
            res.end(page('Broker Proxy administration', form('/login', session.csrf, field('secret', 'Admin secret', 'password') + '<button>Sign in</button>')));
            return;
        }
        if (url.pathname === '/api/status') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(this.broker.view()));
            return;
        }
        if (url.pathname !== '/')
            throw new Fault('NOT_FOUND', 404);
        const v = this.broker.view();
        const quota = (a) => a.quota ? `${a.quota.short.used}% short / ${a.quota.weekly.used}% weekly; observed ${new Date(a.quota.observedAt).toISOString()}` : 'Unknown (not zero)';
        const action = (path, id, label, extra = '') => form(path, session.csrf, `<input type="hidden" name="id" value="${esc(id)}">${extra}<button>${label}</button>`);
        const accounts = v.accounts.map(a => `<tr><td>${esc(a.label)}<small>${esc(a.labels.join(', '))}</small></td><td>${a.enabled ? 'Active' : 'Disabled'} / ${esc(a.authState)}${a.blocked ? ' / quota blocked' : ''}<small>${esc(a.lastError)}</small></td><td>${esc(quota(a))}</td><td>${action('/account/state', a.id, a.enabled ? 'Deactivate' : 'Activate', `<input type="hidden" name="enabled" value="${!a.enabled}">`)}${action('/account/refresh', a.id, 'Refresh')}${action('/account/labels', a.id, 'Save labels', `<label>Labels <input name="labels" value="${esc(a.labels.join(', '))}"></label>`)}</td></tr>`).join('');
        const callers = v.callers.map(c => `<li>${esc(c.label)} — allow: ${esc(c.allow.join(', ') || 'all')}; block: ${esc(c.block.join(', ') || 'none')}${action('/caller/state', c.id, c.enabled ? 'Disable caller' : 'Enable caller', `<input type="hidden" name="enabled" value="${!c.enabled}">`)}</li>`).join('');
        res.end(page('Broker Proxy', `<p>${v.counters.selected} selections · ${v.counters.responses} upstream responses · ${v.counters.errors} upstream errors. Token usage: unknown.</p>
      <p><a href="${esc(this.config.enrollment.origin)}" target="_blank" rel="noreferrer">Enroll through provider device login</a></p>
      <table><caption>Accounts and quota snapshots</caption><thead><tr><th>Account</th><th>Status</th><th>Quota</th><th>Actions</th></tr></thead><tbody>${accounts || '<tr><td colspan="4">No accounts yet.</td></tr>'}</tbody></table>
      <details><summary>Protected manual credential import (administration/testing only)</summary>${form('/account/import', session.csrf, field('label', 'Label') + field('labels', 'Comma-separated labels') + '<label>Private auth.json <textarea name="auth" required autocomplete="off"></textarea></label><button>Import account</button>')}</details>
      <h2>Callers</h2><ul>${callers}</ul>${form('/caller/add', session.csrf, field('label', 'Caller label') + field('secret', 'New caller secret (at least 32 characters)', 'password') + '<label>Allowed labels (blank means all) <input name="allow"></label><label>Blocked labels <input name="block"></label><button>Add caller</button>')}
      <h2>Recent selections</h2><ul>${v.history.slice(-20).reverse().map(h => `<li>${esc(new Date(h.at).toISOString())}: ${esc(v.callers.find(c => c.id === h.caller)?.label)} → ${esc(v.accounts.find(a => a.id === h.account)?.label)}; exchange ${esc(h.exchange)}, attempt ${h.attempt}</li>`).join('')}</ul>${form('/logout', session.csrf, '<button>Sign out</button>')}`));
    }
    async listen() { await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.listener.port, this.listener.host, () => { this.server.removeListener('error', reject); resolve(); }); }); }
    async close() { await new Promise(resolve => { this.server.close(() => resolve()); this.server.closeAllConnections(); }); this.sessions.clear(); }
}
async function body(req) {
    let size = 0;
    const parts = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 256 * 1024)
            throw new Fault('BODY_TOO_LARGE', 413);
        parts.push(chunk);
    }
    return new URLSearchParams(Buffer.concat(parts).toString());
}
export async function startWeb(broker, config) {
    const admin = new Site(broker, config, false), enrollment = new Site(broker, config, true);
    try {
        await admin.listen();
        await enrollment.listen();
    }
    catch (e) {
        await Promise.all([admin.close(), enrollment.close()]);
        throw e;
    }
    return async () => { await Promise.all([admin.close(), enrollment.close()]); };
}
