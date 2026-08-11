import { installProcessGuards } from '../../src/process-guards.js';

const guards = installProcessGuards({
  logger: { error: () => {}, warn: () => {} },
  onFatal: () => {},
});

// The exact D10 shapes: plain-object rejection and a bare Symbol rejection.
Promise.reject({ code: '404', message: 'Call not found' });
Promise.reject(Symbol('sw-execute-connection-closed'));

setTimeout(() => {
  console.log(`still-alive absorbed=${guards.counts.unhandledRejections}`);
  process.exit(0);
}, 50);
