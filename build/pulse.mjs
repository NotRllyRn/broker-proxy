import { Fault, object, text } from './model.mjs';
// Independent implementation of the reference model preference; never guess an unavailable model.
export function pulseModel(raw) {
    const data = object(raw).data;
    if (!Array.isArray(data))
        throw new Fault('PULSE_MODEL_UNKNOWN');
    const models = data.slice(0, 100).flatMap(value => {
        const m = object(value);
        if (m.hidden === true || !Array.isArray(m.inputModalities) || !m.inputModalities.includes('text') || !Array.isArray(m.supportedReasoningEfforts))
            return [];
        const efforts = m.supportedReasoningEfforts.map(e => object(e).reasoningEffort).filter(e => typeof e === 'string');
        if (!efforts.length)
            return [];
        return [{ model: text(m.model, 200), effort: String(efforts.includes('minimal') ? 'minimal' : efforts.includes('low') ? 'low' : efforts[0]) }];
    }).sort((a, b) => Number(!a.model.includes('mini')) - Number(!b.model.includes('mini')) || a.model.localeCompare(b.model));
    if (!models[0])
        throw new Fault('PULSE_MODEL_UNKNOWN');
    return models[0];
}
export async function pulseTurn(runtime, signal, dispatch) {
    const { model, effort } = pulseModel(await runtime.request('model/list', { limit: 100 }));
    const started = object(await runtime.request('thread/start', { ephemeral: true, model, serviceTier: 'default', approvalPolicy: 'never', sandbox: 'read-only' }));
    const threadId = text(object(started.thread).id, 256);
    let turnId, remove = () => { }, abort = () => { };
    // Completion can precede the turn/start response. Keep only bounded IDs/status, never transcript/deltas.
    const early = new Map();
    let accept = () => { };
    const completed = new Promise((resolve, reject) => {
        abort = () => reject(new Fault('CANCELLED', 499));
        signal.addEventListener('abort', abort, { once: true });
        accept = (id, status) => {
            if (turnId) {
                if (id === turnId)
                    resolve(status);
            }
            else {
                if (early.size >= 8) {
                    reject(new Fault('PULSE_NOTIFICATION_LIMIT'));
                    return;
                }
                early.set(id, status);
            }
        };
        remove = runtime.listen((method, params) => {
            try {
                if (method === 'broker/error') {
                    reject(new Fault('PROVIDER_EXITED'));
                    return;
                }
                if (method !== 'turn/completed')
                    return;
                const p = object(params);
                if (p.threadId !== threadId)
                    return;
                const turn = object(p.turn);
                accept(text(turn.id, 256), text(turn.status, 32));
            }
            catch {
                reject(new Fault('PROVIDER_PROTOCOL_ERROR'));
            }
        });
        if (signal.aborted)
            abort();
    });
    completed.catch(() => { });
    try {
        await dispatch(); // Durable ambiguity boundary, and final account/settings check before inference.
        if (signal.aborted)
            throw new Fault('CANCELLED', 499);
        const response = object(await runtime.request('turn/start', { threadId, model, effort, serviceTier: 'default', input: [{ type: 'text', text: 'Reply OK.' }] }));
        turnId = text(object(response.turn).id, 256);
        if (early.has(turnId))
            accept(turnId, early.get(turnId));
        const status = await completed;
        if (!['completed', 'failed', 'interrupted'].includes(status))
            throw new Fault('PROVIDER_PROTOCOL_ERROR');
        return status === 'completed' ? { status: 'completed', model } : { status: 'failed', code: 'PULSE_TURN_FAILED', model };
    }
    finally {
        remove();
        signal.removeEventListener('abort', abort);
    }
}
