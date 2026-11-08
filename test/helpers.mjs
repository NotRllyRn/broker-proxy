import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
export const temp = () => mkdtemp(join(tmpdir(), 'broker-proxy-test-'));
export function auth(id = 'fixture-account', expires = Date.now() + 3600000) {
  return { tokens: { access_token: 'fixture.' + Buffer.from(JSON.stringify({ exp: Math.floor(expires / 1000), 'https://api.openai.com/auth': { chatgpt_account_id: id } })).toString('base64url') + '.not-a-real-signature', refresh_token: 'fixture-refresh-only', id_token: 'fixture-id-only', account_id: id } };
}
export function usage(short = 20, weekly = 30, reset = Date.now() + 600000) {
  return { rateLimits: { primary: { windowDurationMins: 300, usedPercent: short, resetsAt: Math.floor(reset / 1000) }, secondary: { windowDurationMins: 10080, usedPercent: weekly, resetsAt: Math.floor((reset + 600000) / 1000) } } };
}
export async function port() { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
export async function fixtureCommand(dir, mode = 'success') {
  const path = join(dir, 'codex-' + mode);
  await writeFile(path, `#!${process.execPath}\nimport { run } from ${JSON.stringify(resolve('test/provider-fixture.mjs'))};\nrun(${JSON.stringify(mode)});\n`);
  await chmod(path, 0o700); return path;
}
export function browser(origin) {
  let cookie = '', csrf = '';
  return { async request(path = '/', data, extra = {}) {
    const res = await fetch(origin + path, { method: data ? 'POST' : 'GET', redirect: 'manual', headers: {
      Cookie: cookie, ...(data ? { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...extra,
    }, body: data ? new URLSearchParams({ csrf, ...data }) : undefined });
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    const text = await res.text(); csrf = text.match(/name="csrf" value="([^"]+)"/)?.[1] ?? csrf;
    return { status: res.status, text, headers: res.headers };
  } };
}
export const delay = ms => new Promise(r => setTimeout(r, ms));
export async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await delay(25); }
  throw Error('Condition timed out');
}
