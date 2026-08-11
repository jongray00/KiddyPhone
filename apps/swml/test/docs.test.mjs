import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inboundConnect,
  decline,
  park,
  requestFlow,
  outboundConnect,
} from '../src/signalwire/docs.js';

const CHILD = 'sip:child@acme.sip.signalwire.com';
const DEAD = 'sip:deadendpoint@acme.sip.signalwire.com';
const STATUS = 'https://tunnel.example/status';
const AUTH = 'https://tunnel.example/auth';

function main(doc) {
  assert.equal(doc.version, '1.0.0');
  assert.ok(Array.isArray(doc.sections?.main), 'sections.main must be an array');
  return doc.sections.main;
}

test('inboundConnect holds the caller with answer_on_bridge', () => {
  const steps = main(inboundConnect({ to: CHILD, statusUrl: STATUS }));
  const connect = steps.find((s) => s.connect)?.connect;
  assert.ok(connect, 'must contain a connect step');
  assert.equal(connect.answer_on_bridge, true);
  assert.equal(connect.to, CHILD);
  assert.equal(connect.from, '%{call.from}');
  assert.equal(connect.timeout, 30);
  assert.equal(connect.status_url, STATUS);
});

test('inboundConnect ends with hangup so a failed bridge never answers', () => {
  const steps = main(inboundConnect({ to: CHILD }));
  const last = steps[steps.length - 1];
  assert.ok(last === 'hangup' || last.hangup, 'must end in hangup');
});

test('inboundConnect omits status_url when no public URL is configured', () => {
  const steps = main(inboundConnect({ to: CHILD }));
  const connect = steps.find((s) => s.connect)?.connect;
  assert.equal('status_url' in connect, false);
});

test('decline hangs up unanswered with reason decline and no media', () => {
  const steps = main(decline());
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0], { hangup: { reason: 'decline' } });
  const json = JSON.stringify(steps);
  assert.ok(!json.includes('play'), 'decline must never contain media');
  assert.ok(!json.includes('answer'), 'decline must never answer');
});

test('park connects toward the dead endpoint, unanswered, with a long timeout', () => {
  const steps = main(park({ deadUri: DEAD, statusUrl: STATUS }));
  const connect = steps.find((s) => s.connect)?.connect;
  assert.ok(connect, 'must contain a connect step');
  assert.equal(connect.to, DEAD);
  assert.equal(connect.answer_on_bridge, true);
  assert.ok(connect.timeout >= 45, 'park timeout must outlast the check');
  assert.equal(connect.status_url, STATUS);
});

test('requestFlow asks the auth API mid-script and branches on the answer', () => {
  const steps = main(requestFlow({ authUrl: AUTH, childUri: CHILD, statusUrl: STATUS }));

  const request = steps.find((s) => s.request)?.request;
  assert.ok(request, 'must contain a request step');
  assert.equal(request.url, AUTH);
  assert.equal(request.method, 'POST');
  assert.equal(request.save_variables, true);
  assert.deepEqual(request.body, { from: '%{call.from}' });

  const branch = steps.find((s) => s.if)?.if;
  assert.ok(branch, 'must contain an if step');
  assert.equal(branch.condition, "vars.allowed === 'yes'");

  const thenJson = JSON.stringify(branch.then);
  assert.ok(thenJson.includes('"connect"'), 'allowed branch must connect');
  assert.ok(thenJson.includes(CHILD));
  assert.ok(thenJson.includes('"answer_on_bridge":true'));

  const elseJson = JSON.stringify(branch.else);
  assert.ok(elseJson.includes('"decline"'), 'blocked branch must decline');
  assert.ok(!elseJson.includes('"connect"'));
});

test('outboundConnect bridges the child to the validated destination', () => {
  const steps = main(outboundConnect({ to: '+15551234567', statusUrl: STATUS }));
  const connect = steps.find((s) => s.connect)?.connect;
  assert.ok(connect, 'must contain a connect step');
  assert.equal(connect.to, '+15551234567');
  assert.equal(connect.from, '%{call.from}');
  assert.equal(connect.answer_on_bridge, true);
});
