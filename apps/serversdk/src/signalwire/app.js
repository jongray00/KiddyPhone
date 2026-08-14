/**
 * app.js — composition onto @signalwire/sdk (the current server SDK).
 *
 * Differences from the old realtime-api wiring that matter here:
 *   - One RelayClient carries ONE onCall handler for all subscribed contexts
 *     (registering a second replaces the first), so this app subscribes only
 *     to the inbound context and routes nothing.
 *   - Rejections are real Error instances (RelayError extends Error with a
 *     numeric `code`) — the flow logs the shape on every failure so a live
 *     run doubles as evidence.
 *   - connect() takes a device plan (serial groups of parallel devices), not
 *     connectSip/connectPhone variants.
 */

import { RelayClient } from '@signalwire/sdk';
import { createFlow } from './flow.js';

export async function startApp({ config, logger = console, onOffer = null }) {
  const flow = createFlow({ authorize: config.authorize, config, logger });

  const client = new RelayClient({
    project: config.project,
    token: config.token,
    ...(config.host ? { host: config.host } : {}),
    contexts: [config.inboundContext],
  });

  client.onCall((call) => {
    if (onOffer) {
      try { onOffer(call.context, call); } catch { /* observer must never break the flow */ }
    }
    return flow.handleInbound(call).catch((err) => {
      logger.error('handler escaped its own catch', {
        callId: call.callId,
        message: err?.message ?? String(err),
      });
    });
  });

  await client.connect();
  logger.info('listening', { contexts: [config.inboundContext], sdk: '@signalwire/sdk' });

  return {
    client,
    drain: async () => {
      await client.disconnect();
    },
  };
}
