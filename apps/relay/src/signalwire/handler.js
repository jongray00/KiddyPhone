/**
 * handler.js — the flow. One idea: don't answer to decide.
 *
 * Issuing the connect on a leg still in `created` does two things at once: it
 * acknowledges the offer (the platform stops re-offering while the connect
 * lives) and it defers the answer (the A-leg is not billed until the B-leg
 * bridges). That satisfies P1, P2 and P3 and removes D1–D4 at the root.
 *
 * MEASURED (2026-08-14 long-ring matrix): a connect only lives ~20s. Past
 * that the platform kills it (failedReason "error") and, once we release the
 * leg, re-offers the still-ringing caller under a NEW call id. Ringing longer
 * than the window therefore means running this same flow again per re-offer —
 * the guard's initiator/joiner roles keep each cycle to one connect.
 *
 * Blocked callers get hangup('decline') on the unanswered leg: their handset
 * never shows connected, no minute is billed, and they learn nothing about
 * the line. Ring-outs default to the same silent release; the configurable
 * exceptions (early-media message, voicemail — the ONE path that answers,
 * and therefore bills, deliberately) live in onNoAnswer/onBusy below.
 */

import { toFault, failedReason } from '../faults.js';
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
  const {
    childSipUri,
    connectDeadlineMs,
    dialTimeoutSec,
    region = 'US',
    outboundCallerId = null,
    // What happens when the child rings out (failedReason noAnswer):
    //   decline               silent release (default; the caller hears busy/failed)
    //   early-media-message   speak on the UNANSWERED leg, then release — no
    //                         answer, no voice minutes (TTS pennies only)
    //   voicemail             the ONE flow that answers: prompt + record.
    //                         Billing starts at the answer, by design.
    noAnswerAction = 'decline',
    noAnswerMessage = 'The person you are calling is not available.',
    // What happens when the child is busy (failedReason busy):
    //   decline | early-media-busy (spoken busy notice on the unanswered leg)
    busyAction = 'decline',
    busyMessage = 'The line is busy. Please try again later.',
  } = config;

  /** Best-effort early media: the leg may already be dead — never crash. */
  async function speakUnanswered(call, text) {
    try {
      const playback = await call.playTTS({ text });
      if (playback?.ended) await playback.ended();
      return true;
    } catch (rejection) {
      const fault = toFault(rejection, 'early-media');
      logger.debug('early media unavailable', { callId: call.callId, code: fault.code, message: fault.message });
      return false;
    }
  }

  async function onNoAnswer(call) {
    if (noAnswerAction === 'early-media-message') {
      await speakUnanswered(call, noAnswerMessage);
      await safeHangup(call, 'decline', logger);
      return;
    }
    if (noAnswerAction === 'voicemail') {
      try {
        await call.answer(); // deliberate: voicemail cannot exist without media both ways
        const playback = await call.playTTS({ text: noAnswerMessage });
        if (playback?.ended) await playback.ended();
        const recording = await call.recordAudio({ endSilenceTimeout: 3 });
        if (recording?.ended) await recording.ended();
      } catch (rejection) {
        const fault = toFault(rejection, 'voicemail');
        logger.error('voicemail flow failed', { callId: call.callId, code: fault.code, message: fault.message });
      }
      await safeHangup(call, 'hangup', logger);
      return;
    }
    await safeHangup(call, 'hangup', logger);
  }

  async function onBusy(call) {
    if (busyAction === 'early-media-busy') {
      await speakUnanswered(call, busyMessage);
    }
    await safeHangup(call, 'busy', logger);
  }

  /** PSTN legs need an E.164 caller id; a SIP-URI `from` falls back to config. */
  const pstnFrom = (rawFrom) => toE164(rawFrom, region) || outboundCallerId || '';

  /**
   * Authorize failing closed: an auth-API error must not admit a stranger, so
   * it reads as "not allowed" — logged loudly, because the failure mode is a
   * parent who cannot reach their child, not an alert.
   */
  async function checkAllowed(identity, callId, direction) {
    try {
      return (await authorize(identity, direction)) === true;
    } catch (rejection) {
      const fault = toFault(rejection, 'authorize');
      logger.error('authorization lookup failed — failing closed', {
        callId,
        identity,
        direction,
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

  async function runFlow(call, { identity, target, direction }) {
    registry.add(call);
    try {
      const allowed = await checkAllowed(identity, call.callId, direction);
      logger.info('decision', { callId: call.callId, identity, allowed, state: call.state });

      if (!allowed) {
        // Decline on the unanswered leg. No connected state, no billed minute.
        await safeHangup(call, 'decline', logger);
        return;
      }

      const { outcome, fault, role } = await connectUnanswered(call, target);

      if (role === 'joiner') {
        // This delivery joined a flight another call object initiated. Whatever
        // the outcome, THAT call owns it — holding or hanging up this one acts
        // on the wrong leg (the joiner's id is usually already dead, and the
        // hangup was what tore down live bridges).
        logger.info('another delivery owns this flight — standing down', {
          callId: call.callId,
          outcome,
        });
        return;
      }
      if (outcome === Outcome.STOOD_DOWN) {
        // A 409 that still reached us (multi-worker, lock miss): someone
        // else's connect is in flight. Log and walk away (D4).
        logger.info('connect already in flight, standing down', { callId: call.callId });
        return;
      }
      if (outcome === Outcome.GONE) {
        logger.debug('call id no longer exists, nothing to do', { callId: call.callId });
        return;
      }
      if (shouldTeardown(outcome)) {
        const reason = failedReason(fault);
        logger.error('connect failed', {
          callId: call.callId,
          reason,
          code: fault?.code ?? null,
          message: fault?.message ?? null,
        });
        if (reason === 'noAnswer') return onNoAnswer(call);
        if (reason === 'busy') return onBusy(call);
        // 'error' is the platform ending a connect that outlived its ~20s
        // window. Releasing the leg is what hands the still-ringing caller
        // back as a fresh offer (measured) — the flow then runs again on the
        // new call id: the "switch lines" pattern.
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
      direction: 'inbound',
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

    return runFlow(call, { identity, target, direction: 'outbound' });
  }

  return { handleInbound, handleOutbound };
}
