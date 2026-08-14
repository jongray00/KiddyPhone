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

  const oneOf = (key, allowed, fallback) => {
    const v = (env[key] || '').trim() || fallback;
    if (!allowed.includes(v)) {
      throw new Error(`${key} must be one of ${allowed.join(', ')} — got "${v}"`);
    }
    return v;
  };

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
    // MEASURED: an unanswered connect lives ~20-21s before the platform kills
    // it with failedReason "error" and re-offers the caller under a new call
    // id — regardless of a larger timeout. 18 rings out CLEANLY (noAnswer,
    // one offer, one id) with margin. Values >= 20 buy nothing but the
    // error/re-offer cycle; longer effective ringing comes from handling the
    // re-offers (each fresh offer restarts the window), not from this knob.
    dialTimeoutSec: Number(env.PWPOC_DIAL_TIMEOUT_SEC || 18),
    // What to do when the child rings out / is busy — see handler.js.
    noAnswerAction: oneOf('PWPOC_NO_ANSWER_ACTION', ['decline', 'early-media-message', 'voicemail'], 'decline'),
    noAnswerMessage: (env.PWPOC_NO_ANSWER_MESSAGE || 'The person you are calling is not available.').trim(),
    busyAction: oneOf('PWPOC_BUSY_ACTION', ['decline', 'early-media-busy'], 'decline'),
    busyMessage: (env.PWPOC_BUSY_MESSAGE || 'The line is busy. Please try again later.').trim(),
    drainTimeoutMs: Number(env.PWPOC_DRAIN_TIMEOUT_MS || 30 * 60 * 1000),
  };
}
