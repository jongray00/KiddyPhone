import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArmer } from '../src/signalwire/arm.js';
import { createApp } from '../src/server.js';
import { createControl } from '../src/control.js';
import { buildWhitelist } from '../src/whitelist.js';

const PUBLIC = 'https://tunnel.example';
const DID_ID = 'did-1';
const SIP_ID = 'sip-1';

/** Fake SignalWire REST: records writes, serves current handler state. */
function fakeSignalWire() {
  const record = {
    did: { call_handler: 'relay_context', call_relay_script_url: null },
    sip: { call_handler: 'default', call_relay_script_url: null },
  };
  const writes = [];
  const fetchImpl = async (url, opts = {}) => {
    const key = url.includes('/phone_numbers/') ? 'did' : 'sip';
    if (opts.method === 'PUT') {
      const body = JSON.parse(opts.body);
      writes.push({ url, body });
      Object.assign(record[key], body);
    }
    return { ok: true, status: 200, json: async () => ({ ...record[key] }) };
  };
  return { record, writes, fetchImpl };
}

function makeArmer(sw) {
  return createArmer({
    spaceUrl: 'demo.signalwire.com',
    projectId: 'proj',
    token: 'tok',
    publicUrl: PUBLIC,
    didId: DID_ID,
    sipEndpointId: SIP_ID,
    fetchImpl: sw.fetchImpl,
  });
}

test('arm(single) points the DID at /inbound and verifies by fresh GET', async () => {
  const sw = fakeSignalWire();
  const result = await makeArmer(sw).arm('single');
  assert.equal(result.ok, true);
  assert.equal(sw.writes[0].url, `https://demo.signalwire.com/api/relay/rest/phone_numbers/${DID_ID}`);
  assert.deepEqual(sw.writes[0].body, {
    call_handler: 'relay_script',
    call_relay_script_url: `${PUBLIC}/inbound`,
  });
  assert.equal(result.state.did.scenario, 'single');
});

test('arm(twostep) and arm(request-flow) select their routes', async () => {
  const sw = fakeSignalWire();
  const armer = makeArmer(sw);
  await armer.arm('twostep');
  assert.equal(sw.writes[0].body.call_relay_script_url, `${PUBLIC}/inbound/twostep`);
  const result = await armer.arm('request-flow');
  assert.equal(sw.writes[1].body.call_relay_script_url, `${PUBLIC}/inbound/request-flow`);
  assert.equal(result.state.did.scenario, 'request-flow');
});

test('arm(outbound) re-points the SIP endpoint calling handler', async () => {
  const sw = fakeSignalWire();
  const result = await makeArmer(sw).arm('outbound');
  assert.equal(sw.writes[0].url, `https://demo.signalwire.com/api/relay/rest/endpoints/sip/${SIP_ID}`);
  assert.deepEqual(sw.writes[0].body, {
    call_handler: 'relay_script',
    call_relay_script_url: `${PUBLIC}/outbound`,
  });
  assert.equal(result.state.outbound.armed, true);
});

test('arm(outbound-off) restores the default calling handler', async () => {
  const sw = fakeSignalWire();
  const armer = makeArmer(sw);
  await armer.arm('outbound');
  const result = await armer.arm('outbound-off');
  assert.equal(sw.writes[1].body.call_handler, 'default');
  assert.equal(result.state.outbound.armed, false);
});

test('arm rejects unknown scenarios without writing', async () => {
  const sw = fakeSignalWire();
  const result = await makeArmer(sw).arm('rm -rf');
  assert.equal(result.ok, false);
  assert.equal(sw.writes.length, 0);
});

test('state() reports an unarmed DID (relay_context) as scenario null', async () => {
  const sw = fakeSignalWire();
  const state = await makeArmer(sw).state();
  assert.equal(state.did.scenario, null);
  assert.equal(state.did.handler, 'relay_context');
});

test('armer reports transport failure without throwing', async () => {
  const armer = createArmer({
    spaceUrl: 'demo.signalwire.com', projectId: 'p', token: 't', publicUrl: PUBLIC,
    didId: DID_ID, sipEndpointId: SIP_ID,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  const result = await armer.arm('single');
  assert.equal(result.ok, false);
  assert.match(result.error, /offline/);
});

// ── control routes mounted on the app ────────────────────────────────────────

async function withControlApp(t, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pwpoc-'));
  const evidenceFile = join(dir, 'requests.ndjson');
  await writeFile(evidenceFile, JSON.stringify({ ts: 't0', route: '/inbound', body: {} }) + '\n');

  const sw = fakeSignalWire();
  const events = [];
  const capture = { log: async (route, data) => events.push({ route, ...data }), file: evidenceFile };

  const runtime = { checkDelayMs: 5 };
  const whitelist = buildWhitelist({ pstn: ['+14803769009'], region: 'US' });
  const dials = [];
  const control = createControl({
    armer: makeArmer(sw),
    evidenceFile,
    codeDir: new URL('../src', import.meta.url).pathname,
    uiPath: new URL('../src/ui.html', import.meta.url).pathname,
    config: { publicUrl: PUBLIC, didNumber: '+12083799834', whitelistPstn: ['+14803769009'], childUri: 'sip:child@x', deadUri: 'sip:dead@x', checkDelayMs: 5 },
    phone: { username: 'web-user', password: 'pw', domain: 'sip.example' },
    caller: {
      place: async (opts) => {
        dials.push(opts);
        return { answered: false, afterMs: 5, reason: 'decline' };
      },
    },
    whitelist,
    capture,
    callerNumber: '+12083799823',
    runtime,
  });

  const app = createApp({
    whitelist,
    childUri: 'sip:child@x', deadUri: 'sip:dead@x', publicUrl: PUBLIC,
    delayMs: 0, runtime, capture,
    rest: { updateCall: async () => ({ ok: true }) },
    control,
  });

  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  return fn({ base, sw, events, evidenceFile, dials, whitelist });
}

test('GET /ui serves the dashboard HTML', (t) =>
  withControlApp(t, async ({ base }) => {
    const res = await fetch(base + '/ui');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /KiddyPhone/i);
  }));

test('GET /api/state returns config and armed scenario', (t) =>
  withControlApp(t, async ({ base }) => {
    const res = await fetch(base + '/api/state');
    const body = await res.json();
    assert.equal(body.config.didNumber, '+12083799834');
    assert.equal(body.did.handler, 'relay_context');
  }));

test('POST /api/arm arms a scenario end to end', (t) =>
  withControlApp(t, async ({ base, sw }) => {
    const res = await fetch(base + '/api/arm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'twostep' }),
    });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.state.did.scenario, 'twostep');
    assert.equal(sw.writes.length, 1);
  }));

test('GET /api/code serves whitelisted sources and rejects traversal', (t) =>
  withControlApp(t, async ({ base }) => {
    const ok = await fetch(base + '/api/code?file=docs.js');
    assert.equal(ok.status, 200);
    assert.match((await ok.json()).source, /answer_on_bridge/);

    for (const bad of ['../.env', 'nope.js', '..%2F.env', 'ui.html']) {
      const res = await fetch(base + `/api/code?file=${bad}`);
      assert.equal(res.status, 404, `must reject ${bad}`);
    }
  }));

test('GET /api/evidence returns parsed recent lines', (t) =>
  withControlApp(t, async ({ base }) => {
    const res = await fetch(base + '/api/evidence?limit=10');
    const body = await res.json();
    assert.equal(body.lines.length, 1);
    assert.equal(body.lines[0].route, '/inbound');
  }));

test('SSE stream delivers newly appended evidence lines', (t) =>
  withControlApp(t, async ({ base, evidenceFile }) => {
    const res = await fetch(base + '/api/evidence/stream');
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    await appendFile(evidenceFile, JSON.stringify({ ts: 't1', route: '/status' }) + '\n');

    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 3000;
    while (!buf.includes('"/status"') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
    }
    reader.cancel().catch(() => {});
    assert.ok(buf.includes('"/status"'), `stream must carry the new line, got: ${buf.slice(0, 200)}`);
  }));

test('?preview=1 returns SWML without touching evidence capture', (t) =>
  withControlApp(t, async ({ base, events }) => {
    const res = await fetch(base + '/inbound?preview=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ call: { call_id: 'p1', from: '+14803769009' } }),
    });
    const body = await res.json();
    assert.equal(body.version, '1.0.0');
    assert.equal(events.length, 0, 'preview must not be captured');
  }));

test('inbound and outbound capture lines carry the whitelist decision', (t) =>
  withControlApp(t, async ({ base, events }) => {
    await fetch(base + '/inbound', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ call: { call_id: 'd1', from: '+14803769009' } }),
    });
    await fetch(base + '/outbound', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ call: { call_id: 'd2', from: 'sip:child@x', to: '+15550001111' } }),
    });
    const inbound = events.find((e) => e.route === '/inbound' && e.identity?.callId === 'd1');
    const outbound = events.find((e) => e.route === '/outbound' && e.identity?.callId === 'd2');
    assert.equal(inbound.allowed, true, 'inbound line must carry allowed=true');
    assert.equal(outbound.allowed, false, 'outbound line must carry allowed=false');
  }));

test('POST /api/check-delay changes the runtime lookup time', (t) =>
  withControlApp(t, async ({ base }) => {
    const res = await fetch(base + '/api/check-delay', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ms: 10000 }),
    });
    assert.equal((await res.json()).checkDelayMs, 10000);
    const state = await (await fetch(base + '/api/state')).json();
    assert.equal(state.config.checkDelayMs, 10000);
  }));

// The platform strips query strings from external SWML URLs (live finding,
// call f6fed104 2026-08-11): the lookup delay must be server-side runtime
// state, applied to /inbound with no query present.
test('inbound waits the runtime lookup time when no ?delay= arrives', (t) =>
  withControlApp(t, async ({ base }) => {
    await fetch(base + '/api/check-delay', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ms: 150 }),
    });
    const started = Date.now();
    await fetch(base + '/inbound', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ call: { call_id: 'lk1', from: '+14803769009' } }),
    });
    assert.ok(Date.now() - started >= 140, 'inbound must hold for the runtime lookup time');
  }));

test('arm(single) never appends a query string (platform drops them)', async () => {
  const sw = fakeSignalWire();
  await makeArmer(sw).arm('single', { delayMs: 5000 });
  assert.equal(sw.writes[0].body.call_relay_script_url, `${PUBLIC}/inbound`);
});

// The web phone's SIP credentials are served only to the local browser: any
// request that came through the Cloudflare tunnel (cf-ray header) is refused.
test('phone-config serves SIP credentials locally and refuses tunnel requests', (t) =>
  withControlApp(t, async ({ base }) => {
    const local = await fetch(base + '/api/phone-config');
    assert.equal(local.status, 200);
    const cfg = await local.json();
    assert.equal(cfg.username, 'web-user');
    assert.equal(cfg.wss, 'wss://sip.example');
    assert.equal(cfg.aor, 'sip:web-user@sip.example');

    const tunneled = await fetch(base + '/api/phone-config', { headers: { 'cf-ray': 'abc123' } });
    assert.equal(tunneled.status, 403);
  }));

// One click places a real call: the server dials the DID from the space's
// second number. Blocked scenarios first remove that number from the runtime
// whitelist so the webhook denies it.
test('place-call dials the DID and toggles the caller whitelist entry', (t) =>
  withControlApp(t, async ({ base, dials, events }) => {
    const allow = await fetch(base + '/api/place-call', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callerAllowed: true }),
    });
    const allowBody = await allow.json();
    assert.equal(allowBody.ok, true);
    assert.deepEqual(dials[0], { from: '+12083799823', to: '+12083799834', timeout: 60 });
    assert.ok(events.some((e) => e.route === '/place-call#result' && e.callerAllowed === true));

    const blocked = await fetch(base + '/api/place-call', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callerAllowed: false }),
    });
    assert.equal((await blocked.json()).ok, true);
    assert.equal(dials.length, 2);
  }));

test('place-call refuses tunnel requests', (t) =>
  withControlApp(t, async ({ base }) => {
    const res = await fetch(base + '/api/place-call', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-ray': 'x' },
      body: JSON.stringify({ callerAllowed: true }),
    });
    assert.equal(res.status, 403);
  }));
