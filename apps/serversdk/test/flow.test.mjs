/**
 * flow.test.mjs — the serversdk decision flow, same promise as the relay app:
 * never answer(); allowed callers get connect on the unanswered leg; blocked
 * callers get hangup('decline'); a 409 on connect is logged and left alone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlow } from '../src/signalwire/flow.js';

class FakeRelayError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fakeCall({ from = '+15551230001', connectImpl, connectOutcome = 'connected' } = {}) {
  const log = [];
  return {
    log,
    callId: 'call-1',
    context: 'pwpoc_inbound',
    // The current SDK carries identity in the wire device descriptor, not in
    // a `from` property (measured live: call.from is undefined on inbound).
    device: { type: 'phone', params: { from_number: from, to_number: '+12085550100' } },
    state: 'created',
    async answer() { log.push(['answer']); },
    // connect() resolves at command ACK (measured: {code:'200',message:'Connecting call'});
    // the OUTCOME arrives later as a calling.call.connect event.
    async connect(devices, options) {
      log.push(['connect', devices, options]);
      if (connectImpl) return connectImpl();
      return { code: '200', message: 'Connecting call' };
    },
    async waitFor(eventType, predicate) {
      log.push(['waitFor', eventType]);
      return { connectState: connectOutcome };
    },
    async waitForEnded() {
      log.push(['waitForEnded']);
      return { callState: 'ended' };
    },
    async hangup(reason) { log.push(['hangup', reason ?? 'hangup']); },
  };
}

const config = {
  childSipUri: 'sip:child@demo-pwpoc-child.dapp.signalwire.com',
  dialTimeoutSec: 45,
  region: 'US',
};

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function flowWith(allowed, overrides = {}) {
  return createFlow({
    authorize: async () => allowed,
    config,
    logger: silent,
    ...overrides,
  });
}

test('allowed caller: connect on the unanswered leg, never answer, hold until ended', async () => {
  const call = fakeCall({ connectOutcome: 'connected' });
  await flowWith(true).handleInbound(call);

  const kinds = call.log.map(([k]) => k);
  assert.ok(!kinds.includes('answer'), 'must never answer');
  const connect = call.log.find(([k]) => k === 'connect');
  assert.ok(connect, 'connect must be issued');
  assert.deepEqual(connect[1], [[{
    type: 'sip',
    params: { to: config.childSipUri, from: '+15551230001', timeout: 45 },
  }]]);
  assert.ok(kinds.includes('waitForEnded'), 'bridged call is held until it ends');
});

test('connect outcome failed: release the caller so the platform can re-offer', async () => {
  const call = fakeCall({ connectOutcome: 'failed' });
  await flowWith(true).handleInbound(call);

  const kinds = call.log.map(([k]) => k);
  assert.ok(!kinds.includes('answer'));
  assert.ok(!kinds.includes('waitForEnded'), 'a failed connect is not held');
  assert.deepEqual(call.log.find(([k]) => k === 'hangup'), ['hangup', 'hangup']);
});

test('blocked caller: hangup(decline) on the unanswered leg, no connect', async () => {
  const call = fakeCall();
  await flowWith(false).handleInbound(call);

  const kinds = call.log.map(([k]) => k);
  assert.ok(!kinds.includes('answer'));
  assert.ok(!kinds.includes('connect'));
  assert.deepEqual(call.log.find(([k]) => k === 'hangup'), ['hangup', 'decline']);
});

test('connect rejecting with 409: stand down, no hangup', async () => {
  const call = fakeCall({
    connectImpl: () => Promise.reject(new FakeRelayError(409, 'Wait for connect to finish')),
  });
  await flowWith(true).handleInbound(call);

  const kinds = call.log.map(([k]) => k);
  assert.ok(!kinds.includes('hangup'), 'hanging up on a 409 tears down the live call');
});

test('connect rejecting with a non-conflict code: release the caller', async () => {
  const call = fakeCall({
    connectImpl: () => Promise.reject(new FakeRelayError(400, 'No valid devices')),
  });
  await flowWith(true).handleInbound(call);

  assert.deepEqual(call.log.find(([k]) => k === 'hangup'), ['hangup', 'hangup']);
});

test('authorize failure fails closed: decline, never connect', async () => {
  const call = fakeCall();
  await flowWith(true, { authorize: async () => { throw new Error('auth api down'); } })
    .handleInbound(call);

  const kinds = call.log.map(([k]) => k);
  assert.ok(!kinds.includes('connect'));
  assert.deepEqual(call.log.find(([k]) => k === 'hangup'), ['hangup', 'decline']);
});
