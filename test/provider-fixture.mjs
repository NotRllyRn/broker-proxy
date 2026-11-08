// Local protocol fixture, not a provider OAuth server and never a usable credential.
import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { auth, usage } from './helpers.mjs';
export function run(mode = 'success') {
  const send = v => process.stdout.write(JSON.stringify(v) + '\n');
  let timer;
  const home = process.env.CODEX_HOME;
  createInterface({ input: process.stdin }).on('line', async line => {
    const { id, method, params } = JSON.parse(line);
    if (method === 'initialized') return;
    let result = {};
    if (method === 'account/login/start') {
      result = { loginId: 'fixture-login', verificationUrl: mode === 'unsafe-url' ? 'https://example.invalid/login' : 'https://auth.openai.com/codex/device', userCode: 'FIXTURE-NOT-LIVE', ...(mode === 'expired' ? { expiresAt: Date.now() + 120 } : {}) };
      if (!['hang', 'expired'].includes(mode)) timer = setTimeout(async () => {
        await writeFile(join(home, 'auth.json'), JSON.stringify(auth()));
        send({ method: 'account/login/completed', params: mode === 'malformed' ? null : { loginId: mode === 'mismatch' ? 'other-login' : 'fixture-login', success: mode !== 'denied' } });
      }, mode === 'slow' ? 2000 : 60);
    }
    if (method === 'account/login/cancel') { clearTimeout(timer); result = {}; }
    if (method === 'account/read') {
      if (mode === 'refresh-failure') { send({ id, error: { message: 'fixture-refresh-secret-must-not-leak' } }); return; }
      let old; try { old = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')); } catch { old = auth(); }
      await writeFile(join(home, 'auth.json'), JSON.stringify(auth(old.tokens.account_id)));
      result = { account: { type: 'chatgpt', email: 'example@example.invalid' } };
    }
    if (method === 'account/rateLimits/read') result = usage();
    send({ id, result });
  });
}
