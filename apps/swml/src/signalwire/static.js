/**
 * static.js
 *
 * The no-tunnel fallback: compile the whitelist INTO an SWML document and
 * host it on the space itself (Call Fabric swml_script resource, served at
 * /relay-bins/<id>), so the DID needs no reachable webhook at call time.
 *
 * Trade-offs vs webhook mode, by design:
 *   - no lookup-delay simulation (the decision is baked into the document)
 *   - PSTN whitelist entries only (call.from for a SIP leg is a full URI;
 *     SIP matching stays a webhook-mode feature)
 *   - whitelist changes require a re-push, which /api/arm does on every arm
 *
 * The document keeps the one inviolable rule from docs.js: never `answer`,
 * never `play`. Allowed callers get connect + answer_on_bridge; everyone
 * else gets the silent decline.
 */

import { safeDescribe, withDeadline } from '../util.js';

const RESOURCE_PATH = 'api/fabric/resources/swml_scripts';

/**
 * Compile the current whitelist to a static SWML document. `keys` is the
 * whitelist's Set of 'pstn:+E164' / 'sip:user@host' entries.
 */
export function compileStatic({ keys, childUri }) {
  const pstn = [...keys]
    .filter((k) => k.startsWith('pstn:'))
    .map((k) => k.slice('pstn:'.length));
  const allowed = [
    { connect: { to: childUri, from: '%{call.from}', timeout: 30, answer_on_bridge: true } },
    { hangup: {} },
  ];
  const denied = [{ hangup: { reason: 'decline' } }];
  return {
    version: '1.0.0',
    sections: {
      main: [
        {
          switch: {
            variable: 'call.from',
            case: Object.fromEntries(pstn.map((n) => [n, allowed])),
            default: denied,
          },
        },
      ],
    },
  };
}

/**
 * Probe + push. Returns { supported:false } when the space has no Call
 * Fabric script hosting (404 on the resource collection); otherwise creates
 * or updates the named script and returns its hosted request_url.
 */
export function createStaticPusher({ spaceUrl, projectId, token, name = 'pwpoc-static', fetchImpl = fetch, deadlineMs = 10_000 }) {
  const auth = 'Basic ' + Buffer.from(`${projectId}:${token}`).toString('base64');
  const base = `https://${spaceUrl}/${RESOURCE_PATH}`;

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
    return { status: res.status, ok: res.ok, json };
  }

  async function probe() {
    const res = await call(`${base}?page_size=1`, 'GET');
    return res.ok;
  }

  async function push(contents) {
    if (!(await probe())) return { supported: false };

    const list = await call(`${base}?page_size=200`, 'GET');
    if (!list.ok) throw new Error(`list swml_scripts: HTTP ${list.status}: ${safeDescribe(list.json)}`);
    const existing = (list.json?.data ?? []).find((r) => r.display_name === name);

    const res = existing
      ? await call(`${base}/${existing.id}`, 'PUT', { name, contents })
      : await call(base, 'POST', { name, contents });
    if (!res.ok) throw new Error(`push swml_script: HTTP ${res.status}: ${safeDescribe(res.json)}`);

    const requestUrl = res.json?.swml_script?.request_url ?? existing?.swml_script?.request_url ?? null;
    if (!requestUrl) throw new Error('push succeeded but no request_url in response');
    return { supported: true, id: res.json?.id ?? existing?.id, requestUrl, created: !existing };
  }

  return { probe, push };
}
