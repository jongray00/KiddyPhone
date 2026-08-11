/**
 * lifecycle.js — D11.
 *
 * disconnect() with live calls orphans them: measured 105 seconds of caller
 * RTP with no BYE after a raw disconnect. And in this design the caller is not
 * answered yet, so an orphan gives them no signal anything is wrong. The only
 * legal shutdown is: stop taking new calls (the listen() unsubscribe), drain
 * active calls to zero (force-hangup stragglers at the deadline), THEN
 * disconnect. rawDisconnect() exists only to prove it refuses to run.
 */

import { Fault, toFault, safeDescribe } from './faults.js';

export class CallRegistry {
  constructor() {
    this._calls = new Set();
  }

  add(call) {
    this._calls.add(call);
  }

  remove(call) {
    this._calls.delete(call);
  }

  get size() {
    return this._calls.size;
  }

  list() {
    return [...this._calls];
  }

  async waitForZero({ timeoutMs = 30 * 60 * 1000, pollMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (this._calls.size > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return true;
  }
}

export function createDrain({
  unlisten,
  disconnect,
  hangupAll,
  registry,
  timeoutMs = 30 * 60 * 1000,
  pollMs = 250,
  logger = console,
}) {
  let draining = null;

  const drain = () => {
    if (draining) return draining;
    draining = (async () => {
      try {
        await unlisten();
      } catch (reason) {
        logger.error('unlisten failed, continuing drain', { fault: safeDescribe(toFault(reason, 'unlisten').message) });
      }
      const clean = await registry.waitForZero({ timeoutMs, pollMs });
      if (!clean) {
        const stragglers = registry.list();
        logger.warn('drain deadline reached, force-hanging stragglers', { count: stragglers.length });
        try {
          await hangupAll(stragglers);
        } catch (reason) {
          logger.error('straggler hangup failed', { fault: safeDescribe(reason) });
        }
      }
      await disconnect();
    })();
    return draining;
  };

  drain.isDraining = () => draining !== null;

  /** The orphan path, kept unreachable. */
  drain.rawDisconnect = () => {
    if (registry.size > 0) {
      throw new Fault(
        `disconnect refused: ${registry.size} active call(s) would be orphaned (no BYE, media continues). Use drain().`,
        { kind: 'refused', context: 'disconnect' }
      );
    }
    return disconnect();
  };

  return drain;
}
