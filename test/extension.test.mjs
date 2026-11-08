import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import setup from '../build/extension.mjs';
import { Broker } from '../build/broker.mjs';
import { Store } from '../build/store.mjs';
import { digest } from '../build/model.mjs';
import { temp, port } from './helpers.mjs';
// Handler contract unit test; installed-host behavior is covered separately by system.test.mjs.
test('request hook fails closed on old hosts and rejects declared trailers/forged identity', async t => {
  const dir = await temp(), path = join(dir, 'config.json'), dataDir = join(dir, 'data');
  const caller = 'fixture-contract-caller-01234567890123456789';
  const seed = new Broker(await Store.open(dataDir), { close: async () => {} }, []);
  await seed.addCaller('Work laptop', caller, [], []); await seed.close();
  await writeFile(path, JSON.stringify({ dataDir, adminHash: digest('fixture-admin'), dashboard: { port: await port() }, enrollment: { port: await port() }, pollMs: 0 }), { mode: 0o600 });
  const previous = process.env.BROKER_CONFIG; process.env.BROKER_CONFIG = path;
  const hooks = new Map(); let cleanup;
  t.after(async () => {
    if (cleanup) await cleanup();
    if (previous === undefined) delete process.env.BROKER_CONFIG; else process.env.BROKER_CONFIG = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await setup({ on: (descriptor, handler) => hooks.set(descriptor.id, handler), cleanup: fn => cleanup = fn, log: () => {}, config: {} });
  const request = { method: 'GET', url: '/v1/models', status: 0, header: { Authorization: [`Bearer ${caller}`], 'X-Broker-Caller': ['forged'], Cookie: ['private-cookie'] } };
  const invoke = extra => hooks.get('authenticate')({ request, ...extra });
  assert.equal(invoke({}).message.status, 503);
  assert.equal(invoke({ requestHasTrailers: true }).message.status, 400);
  const result = invoke({ requestHasTrailers: false });
  assert.equal(result.action, 'replace'); assert.deepEqual(result.message.header, {}); assert.ok(result.metadata.caller);
  assert.equal(invoke({ requestHasTrailers: false, request: { ...request, header: { 'X-Broker-Caller': ['forged'] } } }).message.status, 401);
});
