/**
 * docs.js
 *
 * SWML document builders, plain objects only. The whole design rests on one
 * documented parameter: connect's answer_on_bridge delays the answer until
 * the B-leg answers. The caller hears ringback, nothing is billed, and a
 * blocked caller never sees a connected state, which is the product promise
 * (P1, P2, P3) that ruled out answer-then-check.
 *
 * No builder here ever emits `answer` or `play`. Media on an unanswered leg
 * would force an answer, and an answered call is a billed call (D16).
 */

const VERSION = '1.0.0';

const doc = (main) => ({ version: VERSION, sections: { main } });

const connectStep = ({ to, timeout, statusUrl }) => {
  const connect = {
    to,
    from: '%{call.from}',
    timeout,
    answer_on_bridge: true,
  };
  if (statusUrl) connect.status_url = statusUrl;
  return { connect };
};

/**
 * Allowed inbound caller: ring the child, answer only when the child picks
 * up. If the connect fails or times out, fall through to hangup so the
 * caller is never left answered or dangling.
 */
export function inboundConnect({ to, statusUrl } = {}) {
  return doc([connectStep({ to, timeout: 30, statusUrl }), { hangup: {} }]);
}

/** Blocked caller: hang up the unanswered leg. Silent by design. */
export function decline() {
  return doc([{ hangup: { reason: 'decline' } }]);
}

/**
 * Two-step hold (Nick's design): connect toward a SIP endpoint that never
 * answers. answer_on_bridge keeps the caller unanswered while it "rings";
 * the REST update then replaces this document with the verdict. The timeout
 * only needs to outlast the authorization check, 55s is generous.
 */
export function park({ deadUri, statusUrl } = {}) {
  return doc([connectStep({ to: deadUri, timeout: 55, statusUrl }), { hangup: {} }]);
}

/**
 * In-script variant: the unanswered leg itself asks the auth API, then
 * branches. The decision leaves the webhook response path entirely, which
 * sidesteps the undocumented response budget (U4) for the check itself.
 * The auth API answers {"allowed":"yes"|"no"}; strings avoid guessing how
 * save_variables types a JSON boolean.
 */
export function requestFlow({ authUrl, childUri, statusUrl } = {}) {
  return doc([
    {
      request: {
        url: authUrl,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { from: '%{call.from}' },
        timeout: 10,
        save_variables: true,
      },
    },
    {
      if: {
        condition: "vars.allowed === 'yes'",
        then: [connectStep({ to: childUri, timeout: 30, statusUrl }), { hangup: {} }],
        else: [{ hangup: { reason: 'decline' } }],
      },
    },
  ]);
}

/**
 * Outbound leg: the child dialed out, the destination survived the
 * whitelist, bridge them. Same connect shape; the A-leg here is the child's
 * own device, so the answer semantics are theirs.
 */
export function outboundConnect({ to, statusUrl } = {}) {
  return doc([connectStep({ to, timeout: 30, statusUrl }), { hangup: {} }]);
}
