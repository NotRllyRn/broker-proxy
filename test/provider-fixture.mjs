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
    if (method === 'account/rateLimits/read') result = mode === 'pulse-no-quota' ? {} : usage();
    if (method === 'model/list') {
      if (params.limit !== 100) throw Error('model/list must be bounded');
      const model = (name, extra = {}) => ({ model: name, hidden: false, inputModalities: ['text'], supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'minimal' }], ...extra });
      result = { data: [model('hidden-mini', { hidden: true }), model('image-mini', { inputModalities: ['image'] }), model('fixture-model'), model('fixture-mini')] };
    }
    if (method === 'thread/start') {
      if (!params.ephemeral || params.model !== 'fixture-mini' || params.approvalPolicy !== 'never' || params.sandbox !== 'read-only') throw Error('unsafe thread contract');
      result = { thread: { id: 'fixture-thread' } };
    }
    if (method === 'turn/start') {
      if (params.threadId !== 'fixture-thread' || params.model !== 'fixture-mini' || params.effort !== 'minimal' || params.serviceTier !== 'default' || params.input[0].text !== 'Reply OK.') throw Error('incorrect turn contract');
      const saved = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'));
      saved.tokens.refresh_token = 'fixture-rotated-after-pulse'; await writeFile(join(home, 'auth.json'), JSON.stringify(saved));
      result = { turn: { id: 'fixture-turn', status: 'inProgress' } };
      const completed = () => send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: mode === 'pulse-error' ? 'failed' : 'completed' } } });
      if (mode === 'pulse-rpc-error') { send({ id, error: { message: 'private-pulse-error-must-not-leak' } }); return; }
      if (mode === 'pulse-malformed') { send({ id, result }); send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: null } }); return; }
      if (mode === 'pulse-truncated') { send({ id, result }); process.stdout.write('{"method":"turn/completed"'); setTimeout(() => process.exit(0), 10); return; }
      if (mode === 'pulse-hang') { send({ id, result }); return; }
      if (mode === 'pulse-flood') { send({ id, result }); for (let i = 0; i < 10; i++) process.stdout.write('x'.repeat(1024 * 1024)); return; }
      // Unrelated/late notifications and transcript deltas must not complete the pulse or be retained.
      send({ method: 'turn/completed', params: { threadId: 'other-thread', turn: { id: 'fixture-turn', status: 'failed' } } });
      send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'old-turn', status: 'failed' } } });
      for (let i = 0; i < 100; i++) send({ method: 'item/agentMessage/delta', params: { delta: 'discard-private-output' } });
      if (mode === 'pulse-early') completed(); else setTimeout(completed, 30);
    }
    send({ id, result });
  });
}
