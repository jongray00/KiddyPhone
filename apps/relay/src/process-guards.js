/**
 * process-guards.js — D10.
 *
 * Node 15+ terminates on unhandled rejection, and this SDK rejects with plain
 * objects and Symbols that no normal error path catches. One un-awaited
 * hangup() then ends the worker and drops every concurrent call on it — for a
 * phone product, one bad call killing thirty good ones.
 *
 * unhandledRejection: absorb, log (Symbol-safe), count. The rejection already
 * escaped every handler; crashing the worker adds damage, not information.
 *
 * uncaughtException: the process state is suspect — hand control to onFatal
 * (drain, then exit) exactly once rather than dying mid-call with no BYEs.
 */

import { toFault, safeDescribe } from './faults.js';

export function installProcessGuards({ logger = console, onFatal = () => {} } = {}) {
  const counts = { unhandledRejections: 0, uncaughtExceptions: 0 };
  let fatalCalled = false;

  const onRejection = (reason) => {
    counts.unhandledRejections += 1;
    const fault = toFault(reason, 'unhandledRejection');
    logger.error('unhandled rejection absorbed', {
      message: fault.message,
      code: fault.code,
      kind: fault.kind,
    });
  };

  const onException = (err) => {
    counts.uncaughtExceptions += 1;
    logger.error('uncaught exception', { message: safeDescribe(err) });
    if (!fatalCalled) {
      fatalCalled = true;
      onFatal(toFault(err, 'uncaughtException'));
    }
  };

  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);

  return {
    counts,
    uninstall() {
      process.off('unhandledRejection', onRejection);
      process.off('uncaughtException', onException);
    },
  };
}
