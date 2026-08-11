/**
 * env.mjs — root .env loader that never overrides what the parent process set.
 *
 * The gateway injects credentials per selected space when it spawns the apps;
 * the root .env (demo space) is only the fallback for running pieces by hand.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadRootEnv() {
  const envPath = path.join(repoRoot, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
