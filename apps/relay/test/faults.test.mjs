import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayCode, toFault, safeDescribe, Fault } from '../src/faults.js';

// ── relayCode: D6, C1 — codes arrive as STRINGS on the wire ─────────────────

test('D6: relayCode normalizes the live string-code shape', () => {
  assert.equal(relayCode({ code: '409', message: 'Wait for connect to finish' }), 409);
});

test('D6: relayCode accepts an actual number too', () => {
  assert.equal(relayCode({ code: 404 }), 404);
});

test('D6: relayCode returns null for junk, null, undefined, Symbol', () => {
  assert.equal(relayCode({ code: 'abc' }), null);
  assert.equal(relayCode(null), null);
  assert.equal(relayCode(undefined), null);
  assert.equal(relayCode(Symbol('sw-execute-connection-closed')), null);
  assert.equal(relayCode('409'), null); // a bare string is not an error object
});

test('relayCode survives a throwing code getter', () => {
  const evil = {};
  Object.defineProperty(evil, 'code', { get() { throw new Error('trap'); } });
  assert.equal(relayCode(evil), null);
});

// ── toFault: D5 — plain-object rejections become real Errors with stacks ────

test('D5: the live prototype-less rejection becomes a Fault extends Error', () => {
  const raw = Object.assign(Object.create(null), {
    code: '409',
    message: 'Wait for connect to finish',
  });
  const f = toFault(raw, 'connect');
  assert.ok(f instanceof Error);
  assert.ok(f instanceof Fault);
  assert.equal(f.code, 409);
  assert.match(f.message, /Wait for connect to finish/);
  assert.ok(typeof f.stack === 'string' && f.stack.length > 0);
});

test('D5: live 404 shape carries its code through', () => {
  const f = toFault({ code: '404', message: 'Call not found' });
  assert.equal(f.code, 404);
});

test('toFault passes a real Error through with a numeric code attached', () => {
  const e = new Error('boom');
  e.code = '400';
  const f = toFault(e);
  assert.ok(f instanceof Error);
  assert.equal(f.code, 400);
  assert.match(f.message, /boom/);
});

// ── D8: bare Symbol rejections must not detonate the error handler ──────────

test('D8: a bare Symbol rejection becomes a Fault without throwing', () => {
  const f = toFault(Symbol('sw-execute-connection-closed'), 'shutdown');
  assert.ok(f instanceof Error);
  assert.equal(f.code, null);
  assert.match(f.message, /sw-execute-connection-closed/);
});

test('toFault handles undefined, string, number rejections', () => {
  assert.ok(toFault(undefined) instanceof Error);
  assert.ok(toFault('plain string reason') instanceof Error);
  assert.match(toFault('plain string reason').message, /plain string reason/);
  assert.ok(toFault(42) instanceof Error);
});

// ── safeDescribe: the logger must never fault inside the error path ─────────

test('D8: safeDescribe never throws, even on Symbol (template interpolation would)', () => {
  const sym = Symbol('sw-execute-connection-closed');
  // sanity: this is the trap the naive logger falls into
  assert.throws(() => `${sym}`);
  const s = safeDescribe(sym);
  assert.equal(typeof s, 'string');
  assert.match(s, /sw-execute-connection-closed/);
});

test('safeDescribe handles circular objects', () => {
  const a = {};
  a.self = a;
  assert.equal(typeof safeDescribe(a), 'string');
});

// ── failedReason: routing datum for no-answer / busy / platform-window ───────

test('failedReason reads the SDK dial-failure shape, raw or through toFault', async () => {
  const { toFault, failedReason } = await import('../src/faults.js');
  const raw = { connectState: 'failed', failedReason: 'noAnswer', callId: 'x' };
  assert.equal(failedReason(raw), 'noAnswer');
  assert.equal(failedReason(toFault(raw, 'connect')), 'noAnswer');
  assert.equal(failedReason({ code: '409' }), null);
  assert.equal(failedReason(undefined), null);
  assert.equal(failedReason(toFault(Symbol('junk'), 'connect')), null);
});
