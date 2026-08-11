import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Outcome,
  classify,
  shouldTeardown,
  intentKey,
  ConnectGuard,
  memoizeAuthorizer,
} from '../src/signalwire/connect-guard.js';
import { Fault } from '../src/faults.js';

// ── classification: two of these four must NOT tear the call down ───────────

test('D1/D4: the live 409 shape (string code, plain object) stands down, never tears down', () => {
  const outcome = classify({ code: '409', message: 'Wait for connect to finish' });
  assert.equal(outcome, Outcome.STOOD_DOWN);
  assert.equal(shouldTeardown(outcome), false);
});

test('D2: 404/410 mean the call id is gone — nothing to tear down', () => {
  assert.equal(classify({ code: '404', message: 'Call not found' }), Outcome.GONE);
  assert.equal(classify({ code: '410' }), Outcome.GONE);
  assert.equal(shouldTeardown(Outcome.GONE), false);
});

test('400 "No valid devices" is a real failure and tears down', () => {
  const outcome = classify({ code: '400', message: 'No valid devices' });
  assert.equal(outcome, Outcome.FAILED);
  assert.equal(shouldTeardown(outcome), true);
});

test('D7: timeout and empty-result faults are failures', () => {
  assert.equal(classify(new Fault('x', { kind: 'timeout' })), Outcome.FAILED);
  assert.equal(classify(new Fault('x', { kind: 'empty-result' })), Outcome.FAILED);
});

test('D8: a Symbol rejection classifies as failure without throwing', () => {
  assert.equal(classify(Symbol('sw-execute-connection-closed')), Outcome.FAILED);
});

// ── intent key: the logical call, never the call id ─────────────────────────

test('D2: intent key excludes the call id and normalizes', () => {
  const a = intentKey({ context: 'inbound', from: 'sip:A@X.com', to: '+1555' });
  const b = intentKey({ context: 'inbound', from: ' sip:a@x.com ', to: '+1555' });
  assert.equal(a, b);
  assert.ok(!a.includes('call'), 'no call id component');
});

// ── single flight: duplicates join, they do not race ────────────────────────

test('D2/D3: 19 offer-handler invocations, one connect', async () => {
  const guard = new ConnectGuard();
  let connects = 0;
  const fn = async () => {
    connects += 1;
    await new Promise((r) => setTimeout(r, 20));
    return { peer: 'ok' };
  };
  const key = intentKey({ context: 'inbound', from: 'a', to: 'b' });
  const results = await Promise.all(
    Array.from({ length: 19 }, () => guard.connectOnce(key, fn))
  );
  assert.equal(connects, 1);
  for (const r of results) {
    assert.equal(r.outcome, Outcome.BRIDGED);
    assert.deepEqual(r.response, { peer: 'ok' });
  }
});

test('connectOnce never rejects: a 409 inside becomes STOOD_DOWN', async () => {
  const guard = new ConnectGuard();
  const r = await guard.connectOnce('k', async () => {
    throw { code: '409', message: 'Wait for connect to finish' };
  });
  assert.equal(r.outcome, Outcome.STOOD_DOWN);
  assert.ok(r.fault instanceof Fault);
});

test('connectOnce clears the key after settle so a later logical call can connect', async () => {
  const guard = new ConnectGuard();
  let n = 0;
  const fn = async () => { n += 1; return n; };
  await guard.connectOnce('k', fn);
  await guard.connectOnce('k', fn);
  assert.equal(n, 2);
});

test('D7: connect resolving undefined is a FAILED outcome', async () => {
  const guard = new ConnectGuard();
  const r = await guard.connectOnce('k', async () => undefined);
  assert.equal(r.outcome, Outcome.FAILED);
  assert.equal(r.fault.kind, 'empty-result');
});

// ── memoized authorizer: D3, offer fan-out must not multiply lookups ────────

test('D3: burst of concurrent authorizations does one lookup', async () => {
  let lookups = 0;
  const auth = memoizeAuthorizer(async () => {
    lookups += 1;
    await new Promise((r) => setTimeout(r, 10));
    return true;
  }, { ttlMs: 1000 });
  const results = await Promise.all(Array.from({ length: 19 }, () => auth('+1555')));
  assert.equal(lookups, 1);
  assert.ok(results.every((r) => r === true));
});

test('D3: distinct identities are separate lookups; deny results are cached too', async () => {
  let lookups = 0;
  const auth = memoizeAuthorizer(async (id) => { lookups += 1; return id === 'good'; }, { ttlMs: 1000 });
  assert.equal(await auth('good'), true);
  assert.equal(await auth('bad'), false);
  assert.equal(await auth('bad'), false);
  assert.equal(lookups, 2);
});

test('D3: a FAILED lookup is never cached — the next call retries', async () => {
  let calls = 0;
  const auth = memoizeAuthorizer(async () => {
    calls += 1;
    if (calls === 1) throw new Error('auth API down');
    return true;
  }, { ttlMs: 1000 });
  await assert.rejects(() => auth('x'));
  assert.equal(await auth('x'), true);
  assert.equal(calls, 2);
});

test('D3: cache expires after ttl', async () => {
  let lookups = 0;
  const auth = memoizeAuthorizer(async () => { lookups += 1; return true; }, { ttlMs: 15 });
  await auth('x');
  await new Promise((r) => setTimeout(r, 30));
  await auth('x');
  assert.equal(lookups, 2);
});

test('direction is part of the cache key: inbound and outbound verdicts never share', async () => {
  const seen = [];
  const auth = memoizeAuthorizer(async (id, dir) => {
    seen.push(`${dir}:${id}`);
    // simulate divergent lists: grandma may call in, child may not dial her
    return dir === 'inbound';
  }, { ttlMs: 1000 });

  assert.equal(await auth('+14803769009', 'inbound'), true);
  assert.equal(await auth('+14803769009', 'outbound'), false, 'cached inbound ALLOW must not answer the outbound question');
  assert.deepEqual(seen, ['inbound:+14803769009', 'outbound:+14803769009'], 'one lookup per direction');
});

test('same caller redialing within the TTL joins the cached verdict, per direction', async () => {
  let lookups = 0;
  const auth = memoizeAuthorizer(async () => { lookups += 1; return true; }, { ttlMs: 1000 });
  await auth('+14803769009', 'inbound'); // first call
  await auth('+14803769009', 'inbound'); // redial
  assert.equal(lookups, 1);
  await auth('+14803769009', 'outbound'); // different question, fresh lookup
  assert.equal(lookups, 2);
});
