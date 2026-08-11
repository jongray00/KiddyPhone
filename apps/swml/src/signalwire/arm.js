/**
 * arm.js
 *
 * Scenario arming: re-point the live call handlers at this server's routes
 * over the SignalWire REST API, the same PUTs used during the live session.
 *
 * The one hard rule in this file: NEVER trust the write's echo. The DID
 * handler silently reverted from relay_script to relay_context once during
 * testing (URL field intact, handler flipped; suspected stale dashboard tab),
 * so every arm() verifies with a fresh GET and returns THAT as the state.
 *
 * Inbound scenarios write the phone number record; the outbound scenario
 * writes the SIP endpoint's calling handler (same field names, confirmed by
 * probe against /api/relay/rest/endpoints/sip/{id}).
 */

import { withDeadline, safeDescribe } from '../util.js';

const INBOUND_ROUTES = {
  single: '/inbound',
  twostep: '/inbound/twostep',
  'request-flow': '/inbound/request-flow',
};

export function createArmer({ spaceUrl, projectId, token, publicUrl, didId, sipEndpointId, fetchImpl = fetch, deadlineMs = 10_000 }) {
  const auth = 'Basic ' + Buffer.from(`${projectId}:${token}`).toString('base64');
  const didUrl = `https://${spaceUrl}/api/relay/rest/phone_numbers/${didId}`;
  const sipUrl = `https://${spaceUrl}/api/relay/rest/endpoints/sip/${sipEndpointId}`;

  async function call(url, method, body) {
    const res = await withDeadline(
      fetchImpl(url, {
        method,
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }),
      deadlineMs,
      `${method} ${url}`,
    );
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${safeDescribe(json)}`);
    return json;
  }

  /** Derive which scenario a handler record is actually serving. */
  function describeDid(record) {
    const handler = record?.call_handler ?? null;
    const rawUrl = record?.call_relay_script_url ?? null;
    let scenario = null;
    let delayMs = null;
    if (handler === 'relay_script' && typeof rawUrl === 'string') {
      try {
        const u = new URL(rawUrl);
        scenario =
          Object.entries(INBOUND_ROUTES).find(([, path]) => u.pathname === path)?.[0] ?? null;
        if (!scenario && u.pathname.startsWith('/relay-bins/')) scenario = 'static';
        if (u.searchParams.has('delay')) delayMs = Number(u.searchParams.get('delay')) || 0;
      } catch {
        scenario = null;
      }
    }
    return { handler, url: rawUrl, scenario, delayMs };
  }

  function describeOutbound(record) {
    const handler = record?.call_handler ?? null;
    const rawUrl = record?.call_relay_script_url ?? null;
    return {
      handler,
      url: rawUrl,
      armed: handler === 'relay_script' && typeof rawUrl === 'string' && rawUrl.endsWith('/outbound'),
    };
  }

  /** Fresh GETs of both records. The only source of truth for "armed". */
  async function state() {
    const [did, sip] = await Promise.all([call(didUrl, 'GET'), call(sipUrl, 'GET')]);
    return { did: describeDid(did), outbound: describeOutbound(sip) };
  }

  async function arm(scenario) {
    try {
      if (scenario in INBOUND_ROUTES) {
        // No query params on the handler URL: MEASURED (call f6fed104,
        // 2026-08-11) the platform POSTs to the bare path and drops the query
        // string, so anything encoded there silently never arrives. The
        // lookup delay lives in server runtime state instead.
        await call(didUrl, 'PUT', {
          call_handler: 'relay_script',
          call_relay_script_url: `${publicUrl}${INBOUND_ROUTES[scenario]}`,
        });
      } else if (scenario === 'outbound') {
        await call(sipUrl, 'PUT', {
          call_handler: 'relay_script',
          call_relay_script_url: `${publicUrl}/outbound`,
        });
      } else if (scenario === 'outbound-off') {
        await call(sipUrl, 'PUT', { call_handler: 'default' });
      } else {
        return { ok: false, error: `unknown scenario: ${safeDescribe(scenario)}` };
      }
      return { ok: true, state: await state() };
    } catch (err) {
      return { ok: false, error: safeDescribe(err) };
    }
  }

  /**
   * Point the DID at an arbitrary hosted SWML URL (the static-script mode:
   * a /relay-bins/ URL from a pushed swml_script resource). Same
   * verify-with-fresh-GET rule as arm().
   */
  async function armUrl(scriptUrl) {
    try {
      await call(didUrl, 'PUT', {
        call_handler: 'relay_script',
        call_relay_script_url: scriptUrl,
      });
      return { ok: true, state: await state() };
    } catch (err) {
      return { ok: false, error: safeDescribe(err) };
    }
  }

  return { arm, armUrl, state };
}
