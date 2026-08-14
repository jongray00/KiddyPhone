/**
 * flow.js — the KiddyPhone decision on @signalwire/sdk (the current server
 * SDK), kept deliberately raw: no single-flight guard, no dedup. Every offer
 * the platform delivers runs the same flow, so a live run shows exactly what
 * the platform does with an unanswered leg (re-offers? conflicts? which
 * error shapes?) instead of the guard absorbing the evidence.
 *
 * The one inviolable rule carries over from the relay app: never answer().
 * The connect is issued on the leg while it is still `created`, and a 409
 * ("Wait for connect to finish") is logged and left alone — hanging up on it
 * is what tore down live calls on the old SDK.
 */

const CONFLICT = 409;

/** RelayError carries a numeric `code`; anything else reads as unknown. */
function codeOf(err) {
  const c = err?.code;
  return typeof c === 'number' ? c : Number(c) || null;
}

/**
 * Inbound identity on this SDK lives in the wire device descriptor —
 * `call.from` does not exist (measured live; the old SDK's call.from maps
 * here, one of the semantic differences the migration guide catalogs).
 */
export function callerIdentity(call) {
  const p = call?.device?.params ?? {};
  return p.from_number ?? p.from ?? call?.from ?? null;
}

export function createFlow({ authorize, config, logger = console }) {
  const { childSipUri, dialTimeoutSec } = config;

  async function checkAllowed(identity, callId) {
    try {
      return (await authorize(identity)) === true;
    } catch (err) {
      logger.error('authorization lookup failed — failing closed', {
        callId,
        identity,
        message: err?.message ?? String(err),
      });
      return false;
    }
  }

  async function handleInbound(call) {
    const identity = callerIdentity(call);
    const allowed = await checkAllowed(identity, call.callId);
    logger.info('decision', { callId: call.callId, identity, allowed, state: call.state });

    if (!allowed) {
      await call.hangup('decline');
      return;
    }

    try {
      // connect() resolves at the command ACK ({code:'200'}), NOT at the
      // bridge — the outcome arrives later as a calling.call.connect event.
      // (The old SDK's connect resolved/rejected on the outcome itself; this
      // is the largest semantic change the migration guide calls out.)
      const ack = await call.connect([[{
        type: 'sip',
        params: { to: childSipUri, from: identity, timeout: dialTimeoutSec },
      }]]);
      logger.info('connect acknowledged', { callId: call.callId, state: call.state, ack });

      const outcome = await call.waitFor(
        'calling.call.connect',
        (e) => {
          const s = e?.connectState ?? e?.params?.connect_state ?? null;
          return s === 'connected' || s === 'failed' || s === 'disconnected';
        },
        (dialTimeoutSec + 15) * 1000,
      );
      const state = outcome?.connectState ?? outcome?.params?.connect_state ?? null;
      logger.info('connect outcome', { callId: call.callId, connectState: state });

      if (state === 'connected') {
        // Bridged; the platform answered the A-leg at B-answer. Hold until
        // the far end drops, then clean up.
        await call.waitForEnded();
        logger.info('call ended after bridge', { callId: call.callId });
        return;
      }

      // Failed (no answer / busy / platform window). Releasing the leg is
      // what hands the still-ringing caller back as a re-offer (measured on
      // the old SDK); leaving it dangling strands them in ringback.
      await call.hangup('hangup');
    } catch (err) {
      const code = codeOf(err);
      const shape = {
        callId: call.callId,
        code,
        message: err?.message ?? String(err),
        isError: err instanceof Error,
        constructor: err?.constructor?.name ?? null,
      };
      if (code === CONFLICT) {
        logger.info('connect conflict — standing down, never hanging up', shape);
        return;
      }
      logger.error('connect failed, releasing caller', shape);
      await call.hangup('hangup');
    }
  }

  return { handleInbound };
}
