/**
 * caller.js
 *
 * The test console's A-leg: a real PSTN call placed through the RELAY SDK
 * from the space's second DID, so one click exercises the whole loop
 * (carrier -> DID -> SWML webhook -> answer_on_bridge -> the in-page phone).
 *
 * dialPhone resolves when the far side answers and rejects on decline or
 * ring-out, which is exactly the caller-side evidence the blocked and
 * no-answer scenarios need. Rejections are plain objects on 4.2.1 (D5), so
 * everything is reported through safeDescribe and a reason extractor; place()
 * never throws. An answered test call stays up briefly, then hangs up itself.
 */

import { SignalWire } from '@signalwire/realtime-api';
import { safeDescribe } from '../util.js';

const TALK_MS = 15_000;

const reasonOf = (err) => {
  const m = safeDescribe(err).match(/"reason":\s*"(\w+)"/);
  return m ? m[1] : null;
};

export function createCaller({ project, token }) {
  let clientPromise = null;
  const client = () => (clientPromise ??= SignalWire({ project, token }));

  async function place({ from, to, timeout = 60 }) {
    const started = Date.now();
    try {
      const c = await client();
      const call = await c.voice.dialPhone({ from, to, timeout });
      setTimeout(() => call.hangup().catch(() => {}), TALK_MS);
      return {
        answered: true,
        afterMs: Date.now() - started,
        callId: call.callId ?? null,
        reason: null,
      };
    } catch (err) {
      return {
        answered: false,
        afterMs: Date.now() - started,
        callId: null,
        reason: reasonOf(err),
        error: safeDescribe(err),
      };
    }
  }

  return { place };
}
