/**
 * app.js — wiring. All policy lives in the modules; this file only composes
 * them onto @signalwire/realtime-api 4.2.1.
 *
 * v4 facts this relies on (verified on the shipped bundle, test/sdk-surface):
 *   - voice.listen({topics, onCallReceived}) is topic-scoped and may be called
 *     once per topic; events are prefixed per topic internally, so two listens
 *     do not clobber each other (the new SDK's onCall DOES — C12 — which is
 *     why routing is per-listen here, not per-callback).
 *   - listen() resolves to an unsubscribe callable which issues
 *     signalwire.unreceive for topics with no other listeners. That
 *     unsubscribe is the first step of the drain (D11).
 *   - waitForDisconnected() is broken on this build (returns the disconnect
 *     method); handler.js uses disconnected() instead.
 */

import { SignalWire } from '@signalwire/realtime-api';
import { isAllowed } from '../identity.js';
import { toFault, safeDescribe } from '../faults.js';
import { ConnectGuard, memoizeAuthorizer } from './connect-guard.js';
import { CallRegistry, createDrain } from '../lifecycle.js';
import { installProcessGuards } from '../process-guards.js';
import { createHandlers, safeHangup } from './handler.js';

export async function startApp({ config, logger = console, onOffer = null }) {
  const registry = new CallRegistry();
  const guard = new ConnectGuard();

  /**
   * Stand-in for KiddyPhone's authorization API: whitelist lookup plus an
   * injectable delay so live tests can hold the decision to ~1.5s, matching
   * their stated check time. Memoized so the offer fan-out cannot multiply
   * lookups (D3).
   */
  const authorize = memoizeAuthorizer(async (identity) => {
    if (config.authDelayMs > 0) {
      await new Promise((r) => setTimeout(r, config.authDelayMs));
    }
    return isAllowed(identity, config.whitelist, { region: config.region });
  }, { ttlMs: config.authTtlMs });

  const handlers = createHandlers({
    authorize,
    guard,
    registry,
    logger,
    config: {
      childSipUri: config.childSipUri,
      connectDeadlineMs: config.connectDeadlineMs,
      dialTimeoutSec: config.dialTimeoutSec,
      region: config.region,
      outboundCallerId: config.outboundCallerId,
    },
  });

  // No `host` option: the documented space-hostname value fails the websocket
  // upgrade (C9). The default endpoint works.
  const client = await SignalWire({ project: config.project, token: config.token });
  const voice = client.voice;

  let draining = false;

  const receive = (topic, handle) =>
    voice.listen({
      topics: [topic],
      onCallReceived: (call) => {
        // The SDK dispatches this callback un-awaited; anything that escapes
        // here is an unhandled rejection, which is D10's second route. Catch
        // everything at the dispatch boundary.
        if (onOffer) {
          try { onOffer(topic, call); } catch { /* observer must never break the flow */ }
        }
        if (draining) {
          safeHangup(call, 'decline', logger).catch(() => {});
          return;
        }
        handle(call).catch((reason) => {
          const fault = toFault(reason, 'dispatch');
          logger.error('handler escaped its own catch', { message: safeDescribe(fault.message) });
        });
      },
    });

  const unsubs = [
    await receive(config.inboundTopic, handlers.handleInbound),
    await receive(config.outboundTopic, handlers.handleOutbound),
  ];

  const drain = createDrain({
    unlisten: async () => {
      draining = true;
      for (const unsub of unsubs) await unsub();
    },
    disconnect: () => client.disconnect(),
    hangupAll: (calls) => Promise.all(calls.map((c) => safeHangup(c, 'hangup', logger))),
    registry,
    timeoutMs: config.drainTimeoutMs,
    logger,
  });

  const guards = installProcessGuards({
    logger,
    onFatal: () => {
      drain().finally(() => process.exit(1));
    },
  });

  logger.info('listening', {
    topics: [config.inboundTopic, config.outboundTopic],
    whitelist: config.whitelist.size,
  });

  return { client, voice, registry, guard, drain, guards, handlers };
}
