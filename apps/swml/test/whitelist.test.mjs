import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSipUri, normalizePstn, buildWhitelist } from '../src/whitelist.js';

const wl = buildWhitelist({
  pstn: ['+15551234567'],
  sip: [{ user: 'PARENT', host: 'acme.sip.signalwire.com' }],
  region: 'US',
});

test('exact E.164 match is allowed', () => {
  assert.equal(wl.isAllowed('+15551234567'), true);
});

// D13: ordinary caller ID formats must not be rejected by exact string match.
test('common PSTN format variants normalize to the same entry', () => {
  for (const variant of [
    '15551234567',
    '5551234567',
    '(555) 123-4567',
    '555-123-4567',
    '1 555 123 4567',
  ]) {
    assert.equal(wl.isAllowed(variant), true, `should allow ${variant}`);
  }
});

test('a number not on the list is denied', () => {
  assert.equal(wl.isAllowed('+15559999999'), false);
});

test('SIP identity with matching user and host is allowed', () => {
  assert.equal(wl.isAllowed('sip:PARENT@acme.sip.signalwire.com'), true);
});

test('SIP matching is case-insensitive on user and host', () => {
  assert.equal(wl.isAllowed('sip:parent@ACME.SIP.signalwire.com'), true);
});

test('display-name angled SIP form is parsed', () => {
  assert.equal(wl.isAllowed('"Parent P" <sip:PARENT@acme.sip.signalwire.com>'), true);
});

// D12: the user part alone must never be enough.
test('same user on a foreign domain is denied', () => {
  assert.equal(wl.isAllowed('sip:PARENT@attacker.com'), false);
});

test('domain-suffix attack is denied (defeats naive endsWith)', () => {
  assert.equal(wl.isAllowed('sip:PARENT@acme.sip.signalwire.com.attacker.com'), false);
});

test('unknown user on the right domain is denied', () => {
  assert.equal(wl.isAllowed('sip:EVE@acme.sip.signalwire.com'), false);
});

test('garbage identities are denied without throwing', () => {
  for (const bad of [null, undefined, '', '   ', 12345, {}, [], 'not-a-number', 'sip:@host', 'sip:user@']) {
    assert.equal(wl.isAllowed(bad), false, `should deny ${String(bad)}`);
  }
});

test('parseSipUri strips params, ports, and handles sips:', () => {
  assert.deepEqual(parseSipUri('sip:U@H.example;transport=udp'), { user: 'U', host: 'h.example' });
  assert.deepEqual(parseSipUri('sips:U@H.example:5061'), { user: 'U', host: 'h.example' });
  assert.equal(parseSipUri('tel:+15551234567'), null);
  assert.equal(parseSipUri('sip:no-at-sign'), null);
});

test('normalizePstn rejects things that are not phone numbers', () => {
  assert.equal(normalizePstn('PARENT', 'US'), null);
  assert.equal(normalizePstn('', 'US'), null);
  assert.equal(normalizePstn(null, 'US'), null);
  assert.equal(normalizePstn('+15551234567', 'US'), '+15551234567');
});

test('an empty whitelist denies everything', () => {
  const empty = buildWhitelist({ pstn: [], sip: [], region: 'US' });
  assert.equal(empty.keys.size, 0);
  assert.equal(empty.isAllowed('+15551234567'), false);
});

test('runtime allow/disallow toggles a PSTN entry without rebuild', () => {
  const w = buildWhitelist({ pstn: ['+15551234567'], region: 'US' });
  assert.equal(w.isAllowed('+12083799823'), false);
  w.allow('+12083799823');
  assert.equal(w.isAllowed('+12083799823'), true);
  w.disallow('+12083799823');
  assert.equal(w.isAllowed('+12083799823'), false);
  assert.equal(w.isAllowed('+15551234567'), true, 'other entries untouched');
});
