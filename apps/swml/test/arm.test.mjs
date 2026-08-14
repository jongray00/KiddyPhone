import test from 'node:test';
import assert from 'node:assert/strict';
import { createArmer } from '../src/signalwire/arm.js';

const SPACE = { spaceUrl: 'acme.signalwire.com', projectId: 'p', token: 't' };
const DID = 'did-1';
const SIP = 'sip-1';

/**
 * A fetch stub over a single mutable pair of records. PUT merges, GET returns
 * what is there — enough to exercise the write-then-verify-with-a-fresh-GET
 * rule the armer is built around.
 */
function stubSpace(initial = {}) {
  const records = {
    [`/api/relay/rest/phone_numbers/${DID}`]: { call_handler: 'relay_context', ...initial.did },
    [`/api/relay/rest/endpoints/sip/${SIP}`]: { call_handler: 'default', ...initial.sip },
  };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const { pathname } = new URL(url);
    const method = opts.method ?? 'GET';
    calls.push({ pathname, method, body: opts.body ? JSON.parse(opts.body) : null });
    if (method === 'PUT') Object.assign(records[pathname], JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => records[pathname] };
  };
  return { fetchImpl, records, calls };
}

test('arms the handler at the public URL, mount path included', async () => {
  const { fetchImpl, records } = stubSpace();
  const armer = createArmer({
    ...SPACE,
    publicUrl: 'https://lab.example/swml',
    didId: DID,
    sipEndpointId: SIP,
    fetchImpl,
  });

  const result = await armer.arm('twostep');
  assert.equal(result.ok, true);
  assert.equal(
    records[`/api/relay/rest/phone_numbers/${DID}`].call_relay_script_url,
    'https://lab.example/swml/inbound/twostep',
  );
  assert.equal(records[`/api/relay/rest/phone_numbers/${DID}`].call_handler, 'relay_script');
});

test('reads back a scenario armed under a mount path', async () => {
  const { fetchImpl } = stubSpace({
    did: {
      call_handler: 'relay_script',
      call_relay_script_url: 'https://lab.example/swml/inbound',
    },
  });
  const armer = createArmer({
    ...SPACE,
    publicUrl: 'https://lab.example/swml',
    didId: DID,
    sipEndpointId: SIP,
    fetchImpl,
  });

  const { did } = await armer.state();
  assert.equal(did.scenario, 'single');
});

test('a bare-path handler still reads as its scenario', async () => {
  // Armed before the lab moved behind the gateway, or by an operator whose
  // PUBLIC_URL has no path. The scenario is still what it is.
  const { fetchImpl } = stubSpace({
    did: {
      call_handler: 'relay_script',
      call_relay_script_url: 'https://tunnel.example/inbound/request-flow',
    },
  });
  const armer = createArmer({
    ...SPACE,
    publicUrl: 'https://lab.example/swml',
    didId: DID,
    sipEndpointId: SIP,
    fetchImpl,
  });

  const { did } = await armer.state();
  assert.equal(did.scenario, 'request-flow');
});

test('a hosted static script reads as static under any prefix', async () => {
  const { fetchImpl } = stubSpace({
    did: {
      call_handler: 'relay_script',
      call_relay_script_url: 'https://acme.signalwire.com/relay-bins/abc-123',
    },
  });
  const armer = createArmer({
    ...SPACE,
    publicUrl: 'https://lab.example/swml',
    didId: DID,
    sipEndpointId: SIP,
    fetchImpl,
  });

  const { did } = await armer.state();
  assert.equal(did.scenario, 'static');
});

test('the outbound handler is armed at the mounted /outbound', async () => {
  const { fetchImpl, records } = stubSpace();
  const armer = createArmer({
    ...SPACE,
    publicUrl: 'https://lab.example/swml',
    didId: DID,
    sipEndpointId: SIP,
    fetchImpl,
  });

  const result = await armer.arm('outbound');
  assert.equal(result.ok, true);
  assert.equal(
    records[`/api/relay/rest/endpoints/sip/${SIP}`].call_relay_script_url,
    'https://lab.example/swml/outbound',
  );
  assert.equal(result.state.outbound.armed, true);
});

test('an unarmed scenario reads as null rather than guessing', async () => {
  const { fetchImpl } = stubSpace({
    did: { call_handler: 'relay_script', call_relay_script_url: 'https://lab.example/swml/nope' },
  });
  const armer = createArmer({
    ...SPACE,
    publicUrl: 'https://lab.example/swml',
    didId: DID,
    sipEndpointId: SIP,
    fetchImpl,
  });

  const { did } = await armer.state();
  assert.equal(did.scenario, null);
});
