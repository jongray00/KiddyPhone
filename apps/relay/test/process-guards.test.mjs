import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const run = promisify(execFile);
const fixture = (name) =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name);

test('D10 baseline: default node DIES on a plain-object unhandled rejection', async () => {
  await assert.rejects(
    () => run(process.execPath, [fixture('unguarded-rejection.mjs')]),
    (err) => {
      assert.notEqual(err.code, 0);
      assert.ok(!String(err.stdout).includes('still-alive'), 'must die before the timer');
      return true;
    }
  );
});

test('D10: guarded worker survives plain-object AND Symbol rejections', async () => {
  const { stdout } = await run(process.execPath, [fixture('guarded-rejection.mjs')]);
  assert.match(stdout, /still-alive absorbed=2/);
});

test('D10: uncaughtException reaches onFatal exactly once instead of a bare crash', async () => {
  const { stdout } = await run(process.execPath, [fixture('guarded-exception.mjs')]);
  assert.match(stdout, /fatal-handled count=1/);
  assert.ok(!stdout.includes('never-reached'));
});
