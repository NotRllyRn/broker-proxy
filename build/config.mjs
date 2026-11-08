import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Fault, object, text, labels } from './model.mjs';
function listener(value, port) {
    const v = value ? object(value) : {};
    const host = typeof v.host === 'string' ? v.host : '127.0.0.1';
    const p = v.port ?? port;
    if (!Number.isInteger(p) || Number(p) < 1 || Number(p) > 65535)
        throw new Fault('INVALID_PORT');
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
    const origin = new URL(typeof v.origin === 'string' ? v.origin : `http://${host.includes(':') ? `[${host}]` : host}:${p}`);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
        || !loopback && origin.protocol !== 'https:' || origin.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname))
        throw new Fault('INVALID_ORIGIN');
    return { host, port: Number(p), origin: origin.origin };
}
export async function loadConfig(path = process.env.BROKER_CONFIG) {
    if (!path || !isAbsolute(path))
        throw new Fault('BROKER_CONFIG_REQUIRED');
    const info = await stat(path);
    if (!info.isFile() || info.size > 65536 || (info.mode & 0o077))
        throw new Fault('CONFIG_MUST_BE_PRIVATE');
    const v = object(JSON.parse(await readFile(path, 'utf8')));
    const dataDir = text(v.dataDir, 4096);
    if (!isAbsolute(dataDir))
        throw new Fault('ABSOLUTE_DATA_DIR_REQUIRED');
    const adminHash = text(v.adminHash);
    if (!/^[a-f0-9]{64}$/.test(adminHash))
        throw new Fault('ADMIN_HASH_REQUIRED');
    const upstream = new URL(typeof v.upstream === 'string' ? v.upstream : 'https://chatgpt.com/backend-api/codex');
    if (!['https:', 'http:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash
        || upstream.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname))
        throw new Fault('UNSAFE_UPSTREAM');
    const pollMs = v.pollMs ?? 90000;
    if (!Number.isSafeInteger(pollMs) || Number(pollMs) !== 0 && (Number(pollMs) < 45000 || Number(pollMs) > 86400000))
        throw new Fault('INVALID_POLL_INTERVAL');
    const dashboard = listener(v.dashboard, 8788), enrollment = listener(v.enrollment, 8789);
    if (dashboard.port === enrollment.port || dashboard.origin === enrollment.origin)
        throw new Fault('SEPARATE_PORTS_REQUIRED');
    return { dataDir, adminHash, upstream: upstream.href.replace(/\/$/, ''), codexCommand: typeof v.codexCommand === 'string' ? text(v.codexCommand, 4096) : 'codex',
        dashboard, enrollment, enrollmentLabels: labels(v.enrollmentLabels ?? ['Personal usage']), pollMs: Number(pollMs), safeFallback: v.safeFallback === true };
}
