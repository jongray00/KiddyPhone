import { installProcessGuards } from '../../src/process-guards.js';

let fatals = 0;
installProcessGuards({
  logger: { error: () => {}, warn: () => {} },
  onFatal: () => {
    fatals += 1;
    // a real app drains here; we just prove we got control exactly once
    console.log(`fatal-handled count=${fatals}`);
    process.exit(0);
  },
});

setTimeout(() => {
  throw new Error('boom');
}, 10);

setTimeout(() => {
  console.log('never-reached');
  process.exit(1);
}, 200);
