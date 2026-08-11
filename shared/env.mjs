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
  loadEnvFile(path.join(repoRoot, '.env'));
}

/** Same never-override parse, any path. Missing file is not an error. */
export function loadEnvFile(envPath) {
  for (const [k, v] of Object.entries(readEnvFile(envPath))) {
    if (!process.env[k]) process.env[k] = v;
  }
}

/** Parse a .env into a plain object without touching process.env. */
export function readEnvFile(envPath) {
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * The https origin this lab is reachable at from the outside — the one fact
 * SignalWire needs before a webhook can be armed.
 *
 * A hosted platform publishes it in the environment (Replit: REPLIT_DEV_DOMAIN,
 * one hostname fronting the gateway's port). A tunnel does not, so
 * PWPOC_PUBLIC_ORIGIN is the manual override. Empty means "no inbound
 * reachability": webhook mode cannot work, RELAY still can.
 */
export function publicOrigin(env = process.env) {
  const explicit = env.PWPOC_PUBLIC_ORIGIN || '';
  const host =
    explicit ||
    env.REPLIT_DEV_DOMAIN ||
    (env.REPLIT_DOMAINS || '').split(',')[0].trim();
  if (!host) return '';
  const bare = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return `https://${bare}`;
}
