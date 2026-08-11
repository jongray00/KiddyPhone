/**
 * deadline.js — D7.
 *
 * On @signalwire/realtime-api 4.2.1 a call-control command that times out at
 * the transport RESOLVES with `undefined` instead of rejecting, so a connect
 * that never happened is indistinguishable from one that did. In the
 * connect-before-answer design the connect is the only thing holding the call,
 * which makes that failure mode fatal. Two traps close it:
 *
 *   withDeadline  — our own ceiling on every SDK await, so a never-settling
 *                   promise becomes a real rejection.
 *   expectResult  — an undefined/null resolution is treated as the failure it is.
 */

import { Fault } from './faults.js';

export function withDeadline(promise, ms, label = 'command') {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Fault(`[${label}] no response within ${ms}ms`, { kind: 'timeout', context: label }));
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export function expectResult(value, label = 'command') {
  if (value == null) {
    throw new Fault(`[${label}] resolved with no result (4.2.1 timeout signature)`, {
      kind: 'empty-result',
      context: label,
    });
  }
  return value;
}
