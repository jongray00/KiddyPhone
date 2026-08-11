import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDeadline, expectResult } from '../src/deadline.js';
import { Fault } from '../src/faults.js';

// ── withDeadline: a command that never settles must FAIL, not hang ──────────

test('D7a: a never-settling command rejects with a timeout Fault at the deadline', async () => {
  const never = new Promise(() => {});
  await assert.rejects(
    () => withDeadline(never, 30, 'connect'),
    (err) => {
      assert.ok(err instanceof Fault);
      assert.equal(err.kind, 'timeout');
      assert.match(err.message, /connect/);
      return true;
    }
  );
});

test('withDeadline passes a timely resolution through untouched', async () => {
  const value = await withDeadline(Promise.resolve({ ok: true }), 1000, 'x');
  assert.deepEqual(value, { ok: true });
});

test('withDeadline passes a timely rejection through untouched (raw, for classification)', async () => {
  const raw = { code: '409', message: 'Wait for connect to finish' };
  await assert.rejects(
    () => withDeadline(Promise.reject(raw), 1000, 'x'),
    (err) => err === raw
  );
});

test('withDeadline does not leave the process hanging after resolution', async () => {
  // If the timer is not cleared, node --test reports the leak; this is a smoke check.
  await withDeadline(Promise.resolve(1), 60_000, 'x');
});

// ── expectResult: D7 — on 4.2.1 a transport timeout RESOLVES undefined ──────

test('D7b: a command that resolved undefined is a failure, not a success', () => {
  assert.throws(
    () => expectResult(undefined, 'connect'),
    (err) => {
      assert.ok(err instanceof Fault);
      assert.equal(err.kind, 'empty-result');
      assert.match(err.message, /connect/);
      return true;
    }
  );
});

test('expectResult rejects null too', () => {
  assert.throws(() => expectResult(null, 'connect'), Fault);
});

test('expectResult returns a real value untouched', () => {
  const peer = { callId: 'abc' };
  assert.equal(expectResult(peer, 'connect'), peer);
});
