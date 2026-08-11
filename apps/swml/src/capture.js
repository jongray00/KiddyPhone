/**
 * capture.js
 *
 * The evidence log. One JSON line per event into evidence/requests.ndjson.
 * This file is how U5 gets settled: after one live call per flow, the raw
 * request bodies in here are the authoritative record of what SignalWire
 * actually POSTs to an SWML webhook. Timestamps double as the U4 record when
 * probing the response budget with DELAY_MS.
 *
 * Append failures are reported to stderr and swallowed: evidence collection
 * must never take the call path down.
 */

import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeDescribe } from './util.js';

export function createCapture(dir) {
  const file = join(dir, 'requests.ndjson');
  let ready = null;

  async function log(route, data) {
    const line = JSON.stringify({ ts: new Date().toISOString(), route, ...data }) + '\n';
    try {
      ready ??= mkdir(dir, { recursive: true });
      await ready;
      await appendFile(file, line);
    } catch (err) {
      console.error('capture failed:', safeDescribe(err));
    }
    // Mirror to stdout so a live test session reads in one place.
    process.stdout.write(line);
  }

  return { log, file };
}
