import { join } from 'node:path';
import { loadConfig } from './config.mjs';
import { Store } from './store.mjs';
import { Broker } from './broker.mjs';
import { CodexProvider } from './provider.mjs';
import { startWeb } from './web.mjs';
import { Fault } from './model.mjs';
const header = (headers, name) => Object.entries(headers).filter(([k]) => k.toLowerCase() === name).flatMap(([, values]) => values);
const safeHeaders = (headers) => Object.fromEntries(Object.entries(headers).filter(([k]) => ['accept', 'content-type', 'content-length', 'user-agent', 'openai-beta', 'x-request-id'].includes(k.toLowerCase())));
const respond = (code, status) => ({ action: 'respond', message: {
        method: '', url: '', status, header: { 'Content-Type': ['application/json'], 'Cache-Control': ['no-store'] },
        body: Buffer.from(JSON.stringify({ error: { code } })).toString('base64'),
    } });
const denied = (e) => respond(e instanceof Fault ? e.code : 'BROKER_UNAVAILABLE', e instanceof Fault ? e.status : 503);
const bearer = (input) => {
    const values = header(input.request.header, 'authorization');
    if (values.length !== 1 || !/^Bearer [\x21-\x7e]{32,256}$/.test(values[0]))
        throw new Fault('UNAUTHORIZED', 401);
    return values[0].slice(7);
};
const setup = async (api) => {
    const config = await loadConfig();
    const store = await Store.open(config.dataDir);
    const broker = new Broker(store, new CodexProvider(join(config.dataDir, 'runtimes'), config.codexCommand), config.enrollmentLabels);
    let closeWeb;
    try {
        closeWeb = await startWeb(broker, config);
    }
    catch {
        await broker.close();
        throw new Error('Broker listeners could not start');
    }
    api.cleanup(async () => { await closeWeb(); await broker.close(); });
    broker.startPolling(config.pollMs);
    api.on({ id: 'authenticate', stage: 'request', bodyMode: 'none', order: -1000, failure: 'block' }, input => {
        try {
            const c = broker.authenticate(bearer(input));
            if (header(input.request.header, 'trailer').length)
                throw new Fault('TRAILERS_UNSUPPORTED', 400);
            const preferred = header(input.request.header, 'x-broker-preferred-account')[0] ?? '';
            return { action: 'replace', message: { ...input.request, header: safeHeaders(input.request.header) }, metadata: { caller: c.id, preferred } };
        }
        catch (e) {
            return denied(e);
        }
    });
    api.on({ id: 'select', stage: 'resolve', bodyMode: 'none', order: 1000, failure: 'block' }, async (input, context) => {
        try {
            if (!input.metadata.caller)
                throw new Fault('UNAUTHORIZED', 401);
            const path = new URL(input.request.url).pathname.replace(/^\/v1\//, '/');
            if (!['/responses', '/models'].includes(path))
                throw new Fault('UNSUPPORTED_PROVIDER_PATH', 404);
            const a = await broker.select(input.metadata.caller, input.metadata.preferred ?? '', input.identity.exchange, input.identity.attempt, context.signal);
            const url = config.upstream + path + new URL(input.request.url).search;
            return { action: 'replace', message: { ...input.request, url, header: safeHeaders(input.request.header) },
                metadata: { ...input.metadata, account: a.id },
                credentials: { Authorization: [`Bearer ${a.credential.accessToken}`], 'Chatgpt-Account-Id': [a.credential.accountId] } };
        }
        catch (e) {
            return denied(e);
        }
    });
    api.on({ id: 'account-outcome', stage: 'observe', bodyMode: 'none', failure: 'block' }, async (input) => {
        if (input.metadata.account && input.metadata.caller)
            await broker.observe(input.metadata.account, input.metadata.caller, input.response.status);
        return { action: 'pass' };
    });
    // Opt-in buffered safe-method fallback. Authentication is explicit again, not host auth inheritance.
    api.on({ id: 'safe-fallback', stage: 'responseStart', bodyMode: 'none', failure: 'block' }, async (input, context) => {
        const safe = (method) => ['GET', 'HEAD', 'OPTIONS'].includes(method);
        if (!config.safeFallback || input.identity.depth !== 0 || !input.metadata.account || input.response.status < 500
            || !safe(input.requested.method) || !safe(input.request.method)
            || header(input.requested.header, 'content-length').some(v => v !== '0')
            || header(input.requested.header, 'transfer-encoding').length
            || header(input.requested.header, 'accept').some(v => v.includes('text/event-stream')))
            return { action: 'pass' };
        const gateway = typeof api.config === 'object' && api.config && !Array.isArray(api.config) ? api.config.gatewayOrigin : null;
        if (typeof gateway !== 'string')
            return { action: 'pass' };
        const url = new URL(input.requested.url), origin = new URL(gateway);
        const authorization = header(input.requested.header, 'authorization');
        if (authorization.length !== 1)
            return { action: 'pass' };
        const result = await context.http({ method: input.requested.method, url: origin.origin + url.pathname + url.search,
            header: { ...safeHeaders(input.requested.header), Authorization: authorization }, status: 0, body: '' });
        return { action: 'replace', message: result };
    });
    api.log('Broker Proxy ready; application-owned authentication; quota snapshots are not token usage');
};
export default setup;
