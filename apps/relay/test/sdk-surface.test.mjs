import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// D14/D15: the package is closed-source and end-of-life. Nothing upstream will
// tell us if the surface drifts, so this file is the tripwire: every SDK member
// the app touches is asserted against the real installed prototypes.

// package.json is not on the exports map; resolve it relative to the entry.
const pkg = require(
  require.resolve('@signalwire/realtime-api').replace(/dist\/index\.node\.js$/, 'package.json')
);
const api = require('@signalwire/realtime-api');

test('D14: the version is pinned to exactly 4.2.1 — behavior was verified on this build', () => {
  assert.equal(pkg.version, '4.2.1');
});

test('SignalWire factory and Voice namespace exist', () => {
  assert.equal(typeof api.SignalWire, 'function');
  assert.equal(typeof api.Voice.Voice, 'function');
  assert.equal(typeof api.Voice.Call, 'function');
});

const callMembers = [
  'answer', 'hangup', 'connect', 'connectSip', 'connectPhone', 'disconnected',
  'from', 'to', 'id', 'callId', 'nodeId', 'context', 'state', 'device', 'type', 'on', 'once', 'off',
];
const voiceMembers = ['listen', 'dial', 'dialSip', 'dialPhone'];

const protoChain = (C) => {
  const names = new Set();
  for (let p = C.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const n of Object.getOwnPropertyNames(p)) names.add(n);
  }
  return names;
};

test('every Call member the app uses exists on the real prototype', () => {
  const members = protoChain(api.Voice.Call);
  for (const m of callMembers) assert.ok(members.has(m), `Call.${m} missing`);
});

test('every Voice-client member the harness uses exists on the real prototype', () => {
  const members = protoChain(api.Voice.Voice);
  for (const m of voiceMembers) assert.ok(members.has(m), `Voice.${m} missing`);
});

test('KNOWN SDK BUG (report R-list): waitForDisconnected returns the disconnect method, not a wait', () => {
  // Verified on the shipped 4.2.1 bundle: `waitForDisconnected() { return this.disconnect; }`.
  // The app must use disconnected() instead. If this test ever fails, the bug
  // was fixed upstream and the workaround note can be dropped.
  const src = String(api.Voice.Call.prototype.waitForDisconnected);
  assert.match(src, /return this\.disconnect(?!\()/);
});
