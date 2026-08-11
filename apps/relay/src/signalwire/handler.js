/**
 * handler.js — the flow. One idea: never call answer().
 *
 * Issuing the connect on a leg still in `created` does two things at once: it
 * acknowledges the offer (the platform stops re-offering — one offer instead
 * of nineteen) and it defers the answer (the A-leg is not billed until the
 * B-leg bridges). That satisfies P1, P2 and P3 and removes D1–D4 at the root.
 *
 * Blocked callers get hangup('decline') on the unanswered leg: their handset
 * never shows connected, no minute is billed, and they learn nothing about the
 * line. The cost, accepted deliberately: no greeting, no rejection message, no
 * voicemail — any media requires answering, and answering means billing.
 */

import { toFault } from '../faults.js';
import { withDeadline } from '../deadline.js';
import { Outcome, intentKey, shouldTeardown } from './connect-guard.js';
import { parseSipUri, toE164 } from '../identity.js';

const hungUp = new WeakSet();

/** Idempotent, absorbs the SDK's junk rejections. Safe to call in any state. */
export async function safeHangup(call, reason = 'hangup', logger = console) {
  if (!call || hungUp.has(call)) return;
  hungUp.add(call);
  try {
    await call.hangup(reason);
  } catch (rejection) {
    const fault = toFault(rejection, 'hangup');
    logger.debug('hangup absorbed', { callId: call.callId, code: fault.code, message: fault.message });
  }
}

export function createHandlers({ authorize, guard, registry, logger = console, config }) {
  const { childSipUri, connectDeadlineMs, dialTimeoutSec, region = 'US', outboundCallerId = null } = config;

  /** PSTN legs need an E.164 caller id; a SIP-URI `from` falls back to config. */
  const pstnFrom = (rawFrom) => toE164(rawFrom, region) || outboundCallerId || '';

  /**
   * Authorize failing closed: an auth-API error must not admit a stranger, so
   * it reads as "not allowed" — logged loudly, because the failure mode is a
   * parent who cannot reach their child, not an alert.
   */
  async function checkAllowed(identity, callId) {
    try {
      return (await authorize(identity)) === true;
    } catch (rejection) {
      const fault = toFault(rejection, 'authorize');
      logger.error('authorization lookup failed — failing closed', {
        callId,
        identity,
        message: fault.message,
      });
      return false;
    }
  }

  /**
   * The guarded connect. The deadline is ours (D7: on 4.2.1 a transport
   * timeout RESOLVES undefined; the guard's expectResult converts that to a
   * failure). The single flight collapses duplicate offers; the classification
   * handles whatever still races through.
   */
  async function connectUnanswered(call, { kind, to, from }) {
    const key = intentKey({ context: call.context, from: call.from, to });
    return guard.connectOnce(key, () => {
      const params = { to, from, timeout: dialTimeoutSec };
      const attempt = kind === 'sip' ? call.connectSip(params) : call.connectPhone(params);
      return withDeadline(attempt, connectDeadlineMs, 'connect');
    });
  }

  async function runFlow(call, { identity, target }) {
    registry.add(call);
    try {
      const allowed = await checkAllowed(identity, call.callId);
      logger.info('decision', { callId: call.callId, identity, allowed, state: call.state });

      if (!allowed) {
        // Decline on the unanswered leg. No connected state, no billed minute.
        await safeHangup(call, 'decline', logger);
        return;
      }

      const { outcome, fault } = await connectUnanswered(call, target);

      if (outcome === Outcome.STOOD_DOWN) {
        // Another delivery of this call owns the bridge. Log and walk away —
        // hanging up here is what tore down live calls (D4).
        logger.info('connect already in flight, standing down', { callId: call.callId });
        return;
      }
      if (outcome === Outcome.GONE) {
        logger.debug('call id no longer exists, nothing to do', { callId: call.callId });
        return;
      }
      if (shouldTeardown(outcome)) {
        logger.error('connect failed, releasing caller', {
          callId: call.callId,
          code: fault?.code ?? null,
          message: fault?.message ?? null,
        });
        await safeHangup(call, 'hangup', logger);
        return;
      }

      // Bridged. The platform answered the A-leg at B-answer; billing started
      // at the bridge. Hold until the far end drops, then clean up.
      logger.info('bridged', { callId: call.callId });
      await call.disconnected();
      await safeHangup(call, 'hangup', logger);
    } catch (rejection) {
      const fault = toFault(rejection, 'handler');
      logger.error('handler failed', { callId: call.callId, code: fault.code, message: fault.message });
      await safeHangup(call, 'hangup', logger);
    } finally {
      registry.remove(call);
    }
  }

  /** Inbound: whitelist the CALLER, bridge to the child. */
  function handleInbound(call) {
    return runFlow(call, {
      identity: call.from,
      target: { kind: 'sip', to: childSipUri, from: call.from },
    });
  }

  /**
   * Outbound: whitelist the DESTINATION the child dialed.
   *
   * An ATA dials digits, so the INVITE arrives as sip:<digits>@<our-domain>.
   * A numeric SIP user means a PSTN destination: authorize and dial the E.164
   * those digits normalize to, never the SIP URI itself (connecting to the raw
   * URI would route back into our own domain app).
   */
  function handleOutbound(call) {
    const rawTo = call.to;
    const sip = parseSipUri(rawTo);
    const digitsAsPstn = sip ? toE164(sip.user, region) : null;

    let identity;
    let target;
    if (sip && digitsAsPstn) {
      identity = digitsAsPstn;
      target = { kind: 'phone', to: digitsAsPstn, from: pstnFrom(call.from) };
    } else if (sip) {
      identity = rawTo;
      target = { kind: 'sip', to: rawTo, from: call.from };
    } else {
      identity = rawTo;
      target = { kind: 'phone', to: toE164(rawTo, region), from: pstnFrom(call.from) };
    }

    return runFlow(call, { identity, target });
  }

  return { handleInbound, handleOutbound };
}
