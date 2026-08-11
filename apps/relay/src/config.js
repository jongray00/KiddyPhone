/**
 * config.js — refuse to start rather than run half-configured. A whitelist
 * product with an empty whitelist is either a lockout (fail closed) or a
 * catastrophe (fail open); neither should be discovered at call time.
 */

import { buildWhitelist } from './identity.js';

function required(env, key) {
  const v = env[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`missing required env: ${key}`);
  }
  return v.trim();
}

export function loadConfig(env = process.env) {
  const project = required(env, 'SIGNALWIRE_PROJECT_ID');
  const token = required(env, 'SIGNALWIRE_TOKEN');
  const childSipUri = required(env, 'PWPOC_CHILD_SIP_URI');
  const region = (env.PWPOC_REGION || 'US').trim();

  let entries;
  try {
    entries = JSON.parse(env.PWPOC_WHITELIST ?? '[]');
  } catch {
    throw new Error('whitelist is not valid JSON — refusing to start');
  }
  const whitelist = buildWhitelist(entries, { region });
  if (whitelist.size === 0) {
    throw new Error('whitelist is empty after normalization — refusing to start');
  }

  return {
    project,
    token,
    childSipUri,
    region,
    whitelist,
    // E.164 presented on PSTN B-legs when the A-leg `from` is a SIP URI.
    outboundCallerId: (env.PWPOC_OUTBOUND_CALLER_ID || '').trim() || null,
    inboundTopic: (env.PWPOC_INBOUND_TOPIC || 'pwpoc_inbound').trim(),
    outboundTopic: (env.PWPOC_OUTBOUND_TOPIC || 'pwpoc_outbound').trim(),
    // Keep the auth check + connect inside the first re-offer window (~5s).
    authTtlMs: Number(env.PWPOC_AUTH_TTL_MS || 5000),
    authDelayMs: Number(env.PWPOC_AUTH_DELAY_MS || 0), // live tests inject 1500 here
    connectDeadlineMs: Number(env.PWPOC_CONNECT_DEADLINE_MS || 35_000),
    dialTimeoutSec: Number(env.PWPOC_DIAL_TIMEOUT_SEC || 30),
    drainTimeoutMs: Number(env.PWPOC_DRAIN_TIMEOUT_MS || 30 * 60 * 1000),
  };
}
