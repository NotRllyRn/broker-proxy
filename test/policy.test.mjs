import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates, rank, inScope, exhausted, retryAt, normalizeUsage, applyQuota, exclude } from '../build/policy.mjs';
import { emptyState } from '../build/model.mjs';
import { usage } from './helpers.mjs';
const now = 1000000;
const caller = { id: 'c', enabled: true, allow: [], block: [] };
const account = (id, extra = {}) => ({ id, enabled: true, authState: 'verified', labels: ['Personal usage'], createdAt: now - 1, blockedAt: null, quota: null, ...extra });
const quota = (weekly, short, used = 5) => ({ weekly: { used, reset: weekly }, short: { used, reset: short }, observedAt: now, startedAt: now });
test('Codex ranking: weekly, short, preference, creation, id; not remaining percent', () => {
  const a = account('a', { quota: quota(now + 100, now + 20, 99) });
  const b = account('b', { quota: quota(now + 200, now + 10, 1) });
  assert.ok(rank(a, b, 'b', now) < 0);
  b.quota.weekly.reset = a.quota.weekly.reset; assert.ok(rank(a, b, 'a', now) > 0);
  b.quota.short.reset = a.quota.short.reset; assert.ok(rank(a, b, 'b', now) > 0);
  assert.ok(rank(a, b, '', now) < 0);
  b.createdAt--; assert.ok(rank(a, b, '', now) > 0);
  b.quota.weekly.reset = now; assert.ok(rank(a, b, 'b', now) < 0);
});
test('scope block overrides allow; preference cannot escape; unknown quota eligible', () => {
  const a = account('a'), b = account('b', { labels: ['Work laptop'] });
  assert.equal(inScope(a, { ...caller, allow: ['Personal usage'], block: ['Personal usage'] }), false);
  const state = { ...emptyState(), accounts: [a, b] };
  assert.deepEqual(candidates(state, { ...caller, allow: ['Work laptop'] }, 'a', now).map(a => a.id), ['b']);
  assert.equal(candidates(state, caller, '', now).length, 2);
});
test('elapsed resets never clear exhaustion or global block; scoped exclusions expire', () => {
  const a = account('a', { quota: quota(now - 1, now - 1, 100) });
  const b = account('b', { blockedAt: now - 100000 });
  const state = { ...emptyState(), accounts: [a, b] };
  assert.equal(exhausted(a), true); assert.equal(candidates(state, caller, '', now).length, 0);
  assert.equal(retryAt(state, caller, now), now + 45000);
  b.blockedAt = null; exclude(state, b, caller.id, true, now);
  assert.equal(candidates(state, caller, '', now).length, 0);
  assert.equal(candidates(state, { ...caller, id: 'other' }, '', now).length, 1);
  assert.equal(candidates(state, caller, '', now + 60000).length, 1);
});
test('complete monotonic observation and read-start grace required to clear quota block', () => {
  const a = account('a', { blockedAt: now, quota: quota(now + 100, now + 100, 100) });
  applyQuota(a, normalizeUsage(usage(), now + 44000, now + 46000)); assert.equal(a.blockedAt, now);
  applyQuota(a, normalizeUsage(usage(), now + 45000, now + 47000)); assert.equal(a.blockedAt, null);
  applyQuota(a, normalizeUsage(usage(100, 100), now + 44000, now + 49000)); assert.equal(a.quota.short.used, 20);
  a.blockedAt = now + 50000; applyQuota(a, normalizeUsage({ rateLimits: { primary: { usedPercent: 0 } } }, now + 100000, now + 100001));
  assert.equal(a.blockedAt, now + 50000); assert.equal(a.quota.weekly.used, 30);
});
test('normalization prefers codex, rejects ambiguous/missing windows; exhaustion reset uses latest window', () => {
  const p = usage(); p.rateLimitsByLimitId = { codex: usage(70, 80).rateLimits };
  assert.equal(normalizeUsage(p, now, now).weekly.used, 80);
  assert.equal(normalizeUsage({ windows: [{ windowDurationMins: 300, usedPercent: 0 }] }, now, now), null);
  const s = { ...emptyState(), accounts: [account('a', { quota: quota(now + 10000, now + 5000, 100) })] };
  assert.equal(retryAt(s, caller, now), now + 10000);
});
