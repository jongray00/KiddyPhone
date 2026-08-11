/**
 * rest.js
 *
 * The Send Call Commands API, used by the two-step flow to hand a parked
 * live call its verdict document:
 *
 *   POST https://{space}.signalwire.com/api/calling/calls
 *   Authorization: Basic base64(project_id:token)
 *   { "command": "update", "params": { "id": "<call_id>", "swml": {...} } }
 *
 * Whether an update lands on an UNANSWERED leg that is mid-connect is one of
 * the things this POC exists to find out, so a failure here is a finding to
 * record, not an exception to crash on. updateCall never throws.
 */

import { withDeadline, safeDescribe } from '../util.js';

export function createRestClient({ spaceUrl, projectId, token, fetchImpl = fetch, deadlineMs = 10_000 }) {
  const url = `https://${spaceUrl}/api/calling/calls`;
  const auth = 'Basic ' + Buffer.from(`${projectId}:${token}`).toString('base64');

  async function updateCall(callId, swml) {
    try {
      const res = await withDeadline(
        fetchImpl(url, {
          method: 'POST',
          headers: {
            authorization: auth,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ command: 'update', params: { id: callId, swml } }),
        }),
        deadlineMs,
        'calling.update',
      );
      const body = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, body, error: res.ok ? null : safeDescribe(body) };
    } catch (err) {
      return { ok: false, status: null, body: null, error: safeDescribe(err) };
    }
  }

  return { updateCall };
}
