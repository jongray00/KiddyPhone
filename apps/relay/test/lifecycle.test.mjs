import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallRegistry, createDrain } from '../src/lifecycle.js';
import { Fault } from '../src/faults.js';

test('CallRegistry tracks active calls and waitForZero resolves when drained', async () => {
  const reg = new CallRegistry();
  const call = { callId: 'a' };
  reg.add(call);
  assert.equal(reg.size, 1);
  const wait = reg.waitForZero({ timeoutMs: 500, pollMs: 5 });
  setTimeout(() => reg.remove(call), 20);
  assert.equal(await wait, true);
});

test('waitForZero returns false at its deadline instead of hanging', async () => {
  const reg = new CallRegistry();
  reg.add({ callId: 'stuck' });
  assert.equal(await reg.waitForZero({ timeoutMs: 30, pollMs: 5 }), false);
});

test('D11: drain order is unlisten -> zero -> disconnect, never the reverse', async () => {
  const order = [];
  const reg = new CallRegistry();
  const call = { callId: 'a' };
  reg.add(call);

  const drain = createDrain({
    unlisten: async () => { order.push('unlisten'); },
    disconnect: async () => { order.push('disconnect'); },
    hangupAll: async () => { order.push('hangupAll'); },
    registry: reg,
    timeoutMs: 500,
    pollMs: 5,
  });

  const p = drain();
  // the in-flight call finishes while draining
  setTimeout(() => { order.push('call-done'); reg.remove(call); }, 20);
  await p;
  assert.deepEqual(order, ['unlisten', 'call-done', 'disconnect']);
});

test('D11: stragglers are force-hung-up at the drain deadline, then disconnect', async () => {
  const order = [];
  const reg = new CallRegistry();
  const call = { callId: 'stuck' };
  reg.add(call);

  const drain = createDrain({
    unlisten: async () => { order.push('unlisten'); },
    disconnect: async () => { order.push('disconnect'); },
    hangupAll: async (calls) => {
      order.push(`hangupAll:${calls.length}`);
      for (const c of calls) reg.remove(c);
    },
    registry: reg,
    timeoutMs: 40,
    pollMs: 5,
  });

  await drain();
  assert.deepEqual(order, ['unlisten', 'hangupAll:1', 'disconnect']);
});

test('D11: raw disconnect is refused while calls are active', async () => {
  const reg = new CallRegistry();
  reg.add({ callId: 'live' });
  let disconnected = false;
  const drain = createDrain({
    unlisten: async () => {},
    disconnect: async () => { disconnected = true; },
    hangupAll: async () => {},
    registry: reg,
    timeoutMs: 500,
    pollMs: 5,
  });
  assert.throws(() => drain.rawDisconnect(), Fault);
  assert.equal(disconnected, false);
  reg.remove({ callId: 'live' }); // not the same object — still active
  assert.equal(reg.size, 1);
});

test('drain is idempotent: concurrent calls join one drain', async () => {
  let unlistens = 0;
  const reg = new CallRegistry();
  const drain = createDrain({
    unlisten: async () => { unlistens += 1; },
    disconnect: async () => {},
    hangupAll: async () => {},
    registry: reg,
    timeoutMs: 100,
    pollMs: 5,
  });
  await Promise.all([drain(), drain(), drain()]);
  assert.equal(unlistens, 1);
});

test('drain continues past an unlisten failure (still disconnects)', async () => {
  const order = [];
  const reg = new CallRegistry();
  const drain = createDrain({
    unlisten: async () => { throw { code: '500', message: 'unreceive failed' }; },
    disconnect: async () => { order.push('disconnect'); },
    hangupAll: async () => {},
    registry: reg,
    timeoutMs: 50,
    pollMs: 5,
  });
  await drain();
  assert.deepEqual(order, ['disconnect']);
});
