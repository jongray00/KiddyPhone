import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSipUri, toE164, buildWhitelist, isAllowed } from '../src/identity.js';

const HOST = 'acme.sip.signalwire.com';
const wl = buildWhitelist(
  [
    { kind: 'pstn', value: '+15551234567' },
    { kind: 'sip', user: 'BRIAN', host: HOST },
  ],
  { region: 'US' }
);

// ── parseSipUri ──────────────────────────────────────────────────────────────

test('parseSipUri handles bare, angled, sips, params, ports', () => {
  assert.deepEqual(parseSipUri(`sip:brian@${HOST}`), { user: 'brian', host: HOST });
  assert.deepEqual(parseSipUri(`"Brian B" <sip:BRIAN@${HOST}>`), { user: 'BRIAN', host: HOST });
  assert.deepEqual(parseSipUri(`sips:brian@${HOST}:5061;transport=tls?x=1`), { user: 'brian', host: HOST });
  assert.equal(parseSipUri('not a uri'), null);
  assert.equal(parseSipUri(null), null);
  assert.equal(parseSipUri(42), null);
});

// ── D12: domain must be part of the identity ────────────────────────────────

test('D12: the four adversarial addresses are all denied', () => {
  const adversarial = [
    'sip:BRIAN@anything.com',                          // right user, wrong domain
    'sip:BRIAN@attacker.com',                          //
    `sip:BRIAN@${HOST}.attacker.com`,                  // suffix confusion, defeats endsWith
    `sip:BRIAN@evil-${HOST}`,                          // prefix confusion
  ];
  for (const addr of adversarial) {
    assert.equal(isAllowed(addr, wl), false, `${addr} must be denied`);
  }
});

test('D12: the genuine SIP identity is admitted, case-insensitively', () => {
  assert.equal(isAllowed(`sip:BRIAN@${HOST}`, wl), true);
  assert.equal(isAllowed(`sip:brian@${HOST.toUpperCase()}`, wl), true);
  assert.equal(isAllowed(`"Brian" <sip:Brian@${HOST}>`, wl), true);
});

// ── D13: ordinary caller-ID formats must be ACCEPTED ────────────────────────

test('D13: the ordinary formats that were being rejected are admitted', () => {
  const ordinary = [
    '+15551234567',        // canonical
    '15551234567',         // no + prefix
    '5551234567',          // bare national digits (live-found case)
    '(555) 123-4567',      // national format
    '+1 555 123 4567',     // spaces
    '555.123.4567',        // dots
  ];
  for (const raw of ordinary) {
    assert.equal(isAllowed(raw, wl), true, `${raw} must be admitted`);
  }
});

test('D13: null/undefined/junk never throw and are denied', () => {
  for (const junk of [null, undefined, '', '   ', {}, 42, Symbol('x'), 'sip:@', '+19999999999']) {
    let result;
    assert.doesNotThrow(() => { result = isAllowed(junk, wl); });
    assert.equal(result, false);
  }
});

// ── toE164 ───────────────────────────────────────────────────────────────────

test('toE164 normalizes national formats and rejects junk', () => {
  assert.equal(toE164('(555) 123-4567', 'US'), '+15551234567');
  assert.equal(toE164('+15551234567', 'US'), '+15551234567');
  assert.equal(toE164('sip:x@y.com', 'US'), null);
  assert.equal(toE164(null, 'US'), null);
});

// ── whitelist construction ───────────────────────────────────────────────────

test('buildWhitelist normalizes entries and drops malformed ones', () => {
  const set = buildWhitelist(
    [
      { kind: 'pstn', value: '(555) 123-4567' },
      { kind: 'pstn', value: 'garbage' },
      { kind: 'sip', user: 'Kid', host: 'X.example.COM' },
      { kind: 'sip', user: '', host: 'x.com' },
    ],
    { region: 'US' }
  );
  assert.equal(set.size, 2);
  assert.ok(set.has('pstn:+15551234567'));
  assert.ok(set.has('sip:kid@x.example.com'));
});
