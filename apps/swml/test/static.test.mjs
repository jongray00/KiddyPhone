import test from 'node:test';
import assert from 'node:assert/strict';
import { compileStatic, createStaticPusher } from '../src/signalwire/static.js';
import { buildWhitelist } from '../src/whitelist.js';

const CHILD = 'sip:child@demo-x.sip.signalwire.com';

test('compileStatic bakes PSTN entries into switch cases, connect-before-answer', () => {
  const wl = buildWhitelist({ pstn: ['+14803769009', '(208) 379-9823'], sip: ['brian@example.sip.signalwire.com'] });
  const doc = compileStatic({ keys: wl.keys, childUri: CHILD });

  assert.equal(doc.version, '1.0.0');
  const sw = doc.sections.main[0].switch;
  assert.equal(sw.variable, 'call.from');
  const cases = Object.keys(sw.case);
  assert.deepEqual(cases.sort(), ['+12083799823', '+14803769009']);
  for (const steps of Object.values(sw.case)) {
    assert.equal(steps[0].connect.to, CHILD);
    assert.equal(steps[0].connect.answer_on_bridge, true);
  }
});

test('compileStatic never answers or plays, and denies by silent decline', () => {
  const wl = buildWhitelist({ pstn: ['+14803769009'] });
  const doc = compileStatic({ keys: wl.keys, childUri: CHILD });
  const flat = JSON.stringify(doc);
  assert.ok(!flat.includes('"answer"'), 'no answer method anywhere');
  assert.ok(!flat.includes('"play"'), 'no play method anywhere');
  assert.deepEqual(doc.sections.main[0].switch.default, [{ hangup: { reason: 'decline' } }]);
});

test('compileStatic excludes SIP whitelist entries (webhook-mode feature)', () => {
  const wl = buildWhitelist({ pstn: [], sip: ['brian@example.sip.signalwire.com'] });
  const doc = compileStatic({ keys: wl.keys, childUri: CHILD });
  assert.deepEqual(Object.keys(doc.sections.main[0].switch.case), []);
});

const mockFetch = (routes) => async (url, opts = {}) => {
  const method = opts.method || 'GET';
  for (const r of routes) {
    if (r.method === method && url.includes(r.match)) {
      if (r.capture) r.capture({ url, opts });
      return { ok: r.status < 400, status: r.status, json: async () => r.body };
    }
  }
  return { ok: false, status: 404, json: async () => null };
};

const CREDS = { spaceUrl: 'acme.signalwire.com', projectId: 'p', token: 't' };

test('pusher reports unsupported when the space has no script hosting', async () => {
  const pusher = createStaticPusher({ ...CREDS, fetchImpl: mockFetch([
    { method: 'GET', match: 'swml_scripts', status: 404, body: null },
  ]) });
  assert.deepEqual(await pusher.push({}), { supported: false });
});

test('pusher creates the script when absent and returns the hosted url', async () => {
  let posted = null;
  const pusher = createStaticPusher({ ...CREDS, fetchImpl: mockFetch([
    { method: 'GET', match: 'swml_scripts', status: 200, body: { data: [] } },
    {
      method: 'POST', match: 'swml_scripts', status: 200,
      capture: (c) => { posted = JSON.parse(c.opts.body); },
      body: { id: 'res-1', swml_script: { request_url: 'https://acme.signalwire.com/relay-bins/abc' } },
    },
  ]) });
  const out = await pusher.push({ version: '1.0.0' });
  assert.equal(out.supported, true);
  assert.equal(out.created, true);
  assert.equal(out.requestUrl, 'https://acme.signalwire.com/relay-bins/abc');
  assert.equal(posted.name, 'pwpoc-static');
  assert.deepEqual(posted.contents, { version: '1.0.0' });
});

test('pusher updates in place when the named script already exists', async () => {
  let putUrl = null;
  const pusher = createStaticPusher({ ...CREDS, fetchImpl: mockFetch([
    {
      method: 'GET', match: 'swml_scripts', status: 200,
      body: { data: [{ id: 'res-9', display_name: 'pwpoc-static', swml_script: { request_url: 'https://acme.signalwire.com/relay-bins/old' } }] },
    },
    {
      method: 'PUT', match: 'swml_scripts/res-9', status: 200,
      capture: (c) => { putUrl = c.url; },
      body: { id: 'res-9', swml_script: { request_url: 'https://acme.signalwire.com/relay-bins/old' } },
    },
  ]) });
  const out = await pusher.push({ version: '1.0.0' });
  assert.equal(out.created, false);
  assert.equal(out.requestUrl, 'https://acme.signalwire.com/relay-bins/old');
  assert.ok(putUrl.endsWith('/res-9'));
});
