import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server.js';
import { buildWhitelist } from '../src/whitelist.js';
import { extractIdentity } from '../src/identity.js';
import { createRestClient } from '../src/signalwire/rest.js';

const CHILD = 'sip:child@acme.sip.signalwire.com';
const DEAD = 'sip:deadendpoint@acme.sip.signalwire.com';
const ALLOWED_FROM = '+15551234567';
const BLOCKED_FROM = '+15559999999';

function makeHarness(overrides = {}) {
  const events = [];
  const updates = [];
  let resolveUpdate;
  const updateSeen = new Promise((r) => (resolveUpdate = r));

  const app = createApp({
    whitelist: buildWhitelist({
      pstn: [ALLOWED_FROM],
      sip: [{ user: 'PARENT', host: 'acme.sip.signalwire.com' }],
      region: 'US',
    }),
    childUri: CHILD,
    deadUri: DEAD,
    publicUrl: 'https://tunnel.example',
    delayMs: 0,
    checkDelayMs: 5,
    capture: {
      log: async (route, data) => {
        events.push({ route, ...data });
      },
    },
    rest: {
      updateCall: async (id, swml) => {
        updates.push({ id, swml });
        resolveUpdate();
        return { ok: true, status: 200, body: null };
      },
    },
    ...overrides,
  });

  return { app, events, updates, updateSeen };
}

async function withApp(t, overrides, fn) {
  const h = makeHarness(overrides);
  h.app.listen(0, '127.0.0.1');
  await once(h.app, 'listening');
  const base = `http://127.0.0.1:${h.app.address().port}`;
  t.after(() => h.app.close());
  const post = async (path, body, raw = false) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return fn({ ...h, base, post });
}

const inboundBody = (from) => ({ call: { call_id: 'call-123', from, to: '+15550000000' } });

test('inbound: whitelisted caller gets connect with answer_on_bridge', (t) =>
  withApp(t, {}, async ({ post }) => {
    const { status, body } = await post('/inbound', inboundBody(ALLOWED_FROM));
    assert.equal(status, 200);
    const connect = body.sections.main.find((s) => s.connect)?.connect;
    assert.equal(connect.to, CHILD);
    assert.equal(connect.answer_on_bridge, true);
  }));

test('inbound: blocked caller gets silent decline', (t) =>
  withApp(t, {}, async ({ post }) => {
    const { status, body } = await post('/inbound', inboundBody(BLOCKED_FROM));
    assert.equal(status, 200);
    assert.deepEqual(body.sections.main, [{ hangup: { reason: 'decline' } }]);
  }));

test('inbound: unparseable body fails closed to decline', (t) =>
  withApp(t, {}, async ({ post }) => {
    const { status, body } = await post('/inbound', 'this is not json', true);
    assert.equal(status, 200);
    assert.deepEqual(body.sections.main, [{ hangup: { reason: 'decline' } }]);
  }));

test('inbound: ?delay= holds the response for the U4 probe', (t) =>
  withApp(t, {}, async ({ post }) => {
    const started = Date.now();
    await post('/inbound?delay=150', inboundBody(ALLOWED_FROM));
    assert.ok(Date.now() - started >= 140, 'response must be delayed');
  }));

test('inbound: every request is captured for U5 evidence', (t) =>
  withApp(t, {}, async ({ post, events }) => {
    await post('/inbound', inboundBody(ALLOWED_FROM));
    const line = events.find((e) => e.route === '/inbound');
    assert.ok(line, 'a capture line must exist');
    assert.equal(line.body.call.call_id, 'call-123');
  }));

test('two-step: parks immediately, then one REST update with the verdict', (t) =>
  withApp(t, {}, async ({ post, updates, updateSeen }) => {
    const { body } = await post('/inbound/twostep', inboundBody(ALLOWED_FROM));
    const connect = body.sections.main.find((s) => s.connect)?.connect;
    assert.equal(connect.to, DEAD, 'must park at the dead endpoint first');
    assert.equal(connect.answer_on_bridge, true);
    assert.equal(updates.length, 0, 'update must not have fired before the check');

    await updateSeen;
    assert.equal(updates.length, 1, 'exactly one update');
    assert.equal(updates[0].id, 'call-123');
    const json = JSON.stringify(updates[0].swml);
    assert.ok(json.includes('"connect"'), 'allowed verdict must connect');
    assert.ok(json.includes(CHILD));
  }));

test('two-step: blocked caller gets a decline verdict over REST', (t) =>
  withApp(t, {}, async ({ post, updates, updateSeen }) => {
    await post('/inbound/twostep', inboundBody(BLOCKED_FROM));
    await updateSeen;
    assert.deepEqual(updates[0].swml.sections.main, [{ hangup: { reason: 'decline' } }]);
  }));

test('request-flow: returns the static request/if document', (t) =>
  withApp(t, {}, async ({ post }) => {
    const { body } = await post('/inbound/request-flow', inboundBody(ALLOWED_FROM));
    const request = body.sections.main.find((s) => s.request)?.request;
    assert.equal(request.url, 'https://tunnel.example/auth');
    const branch = body.sections.main.find((s) => s.if)?.if;
    assert.equal(branch.condition, "vars.allowed === 'yes'");
  }));

test('auth: answers yes/no from the whitelist after the check delay', (t) =>
  withApp(t, {}, async ({ post }) => {
    const yes = await post('/auth', { from: ALLOWED_FROM });
    assert.deepEqual(yes.body, { allowed: 'yes' });
    const no = await post('/auth', { from: BLOCKED_FROM });
    assert.deepEqual(no.body, { allowed: 'no' });
  }));

test('outbound: whitelisted destination connects, others decline', (t) =>
  withApp(t, {}, async ({ post }) => {
    const ok = await post('/outbound', { call: { call_id: 'c2', from: CHILD, to: '(555) 123-4567' } });
    const connect = ok.body.sections.main.find((s) => s.connect)?.connect;
    assert.equal(connect.to, '+15551234567', 'destination must be normalized to E.164');

    const bad = await post('/outbound', { call: { call_id: 'c3', from: CHILD, to: BLOCKED_FROM } });
    assert.deepEqual(bad.body.sections.main, [{ hangup: { reason: 'decline' } }]);
  }));

test('status events are captured', (t) =>
  withApp(t, {}, async ({ post, events }) => {
    const { status } = await post('/status', { event_type: 'calling.call.state', params: { call_state: 'ended' } });
    assert.equal(status, 200);
    assert.ok(events.some((e) => e.route === '/status'));
  }));

test('healthz responds and webhook routes reject GET', (t) =>
  withApp(t, {}, async ({ base }) => {
    const health = await fetch(base + '/healthz');
    assert.equal(health.status, 200);
    const get = await fetch(base + '/inbound');
    assert.equal(get.status, 405);
    const missing = await fetch(base + '/nope', { method: 'POST', body: '{}' });
    assert.equal(missing.status, 404);
  }));

// U5 is open by design: extraction must survive every plausible body shape.
test('extractIdentity tolerates the body shapes seen on both leg types', () => {
  assert.deepEqual(
    extractIdentity({ call: { call_id: 'a', from: '+1555', to: '+1666' } }),
    { from: '+1555', to: '+1666', callId: 'a' },
  );
  assert.deepEqual(
    extractIdentity({ call: { call_id: 'b', from_number: '+1555', to_number: '+1666' } }),
    { from: '+1555', to: '+1666', callId: 'b' },
  );
  assert.deepEqual(
    extractIdentity({ call_id: 'c', from: 'sip:a@b', to: 'sip:c@d' }),
    { from: 'sip:a@b', to: 'sip:c@d', callId: 'c' },
  );
  assert.deepEqual(extractIdentity(null), { from: null, to: null, callId: null });
  assert.deepEqual(extractIdentity('garbage'), { from: null, to: null, callId: null });
});

test('rest client sends the documented update command with basic auth', async () => {
  const seen = [];
  const client = createRestClient({
    spaceUrl: 'example.signalwire.com',
    projectId: 'proj',
    token: 'tok',
    fetchImpl: async (url, opts) => {
      seen.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });

  const swml = { version: '1.0.0', sections: { main: [{ hangup: { reason: 'decline' } }] } };
  const result = await client.updateCall('call-123', swml);

  assert.equal(result.ok, true);
  assert.equal(seen[0].url, 'https://example.signalwire.com/api/calling/calls');
  assert.equal(seen[0].opts.method, 'POST');
  assert.equal(
    seen[0].opts.headers.authorization,
    'Basic ' + Buffer.from('proj:tok').toString('base64'),
  );
  assert.deepEqual(JSON.parse(seen[0].opts.body), {
    command: 'update',
    params: { id: 'call-123', swml },
  });
});

test('rest client reports failure without throwing', async () => {
  const client = createRestClient({
    spaceUrl: 'example.signalwire.com',
    projectId: 'proj',
    token: 'tok',
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  const result = await client.updateCall('call-123', {});
  assert.equal(result.ok, false);
  assert.match(result.error, /network down/);
});
