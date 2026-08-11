# KiddyPhone SWML POC

The inbound whitelist flow rebuilt on SWML instead of a RELAY worker. The design rests on one documented parameter: `connect` with `answer_on_bridge: true` holds the caller unanswered while the child's device rings. The caller hears ringback, nothing is billed, and a blocked caller never sees a connected state. That satisfies all three product requirements (no billing for spam, no connected state for blocked callers, answer only when the child picks up) with a published spec behind it rather than emergent behavior, which is the strongest argument for this path over RELAY (D20).

This POC exists to settle two open items no documentation answers:

- **U4**: how long an external SWML webhook may take to respond before the platform gives up.
- **U5**: the exact request body SignalWire POSTs to an external SWML URL when a call arrives.

## Three flows, side by side

| Route | Flow | Decision happens |
|---|---|---|
| `POST /inbound` | Single webhook | Inline, inside the webhook response window |
| `POST /inbound/twostep` | Park at a dead endpoint, then REST update | Async, after the park document is returned |
| `POST /inbound/request-flow` | Static document with an in-script `request` | Mid-script, on the unanswered leg itself |

**Single webhook** is the simplest and the one the recommendation letter leads with. It assumes KiddyPhone's roughly 1.5 second check fits in the response window, which is exactly what the `DELAY_MS` knob probes.

**Two-step** is what the customer from Support proposed: respond immediately with a `connect` toward a SIP endpoint that never answers (`answer_on_bridge` keeps the caller unanswered while it rings), run the check off the response path, then hand the parked leg its verdict through the Send Call Commands API (`POST /api/calling/calls`, command `update`). Whether that update lands on an unanswered leg that is mid-connect is itself a finding this POC records.

**Request-flow** removes the webhook from the decision entirely: the returned document uses SWML's `request` method to call `/auth` from the unanswered leg, saves the response variables, and branches with `if`. If it holds up live, it makes the response budget question moot for the check itself.

The outbound leg (`POST /outbound`) applies the same whitelist to the destination the child dialed. The relay POC never exercised outbound live, so treat the first live outbound call as an experiment too.

## The test console

`/ui` serves a live test console in the same visual language as the relay POC's Line Test
Console: scenario cards on the left patch the real DID (or the SIP endpoint's calling
handler) at this server over the REST API, a signal ladder renders each call's evidence
as caller / webhook / child lanes, per-scenario checks evaluate against the latest call,
every step links to the live source, and the raw evidence stream runs at the bottom.
The "whitelist lookup time" control sets the in-window delay for the single webhook
(the U4 probe) and the async check time for the park and request flows.

## Running it

Node 20.12 or newer.

```
cd SWML
npm install
cp .env.example .env    # fill in credentials and URIs
npm start
```

Expose it with a Cloudflare tunnel:

```
cloudflared tunnel --url http://localhost:8080
```

Put the printed `https://….trycloudflare.com` base into `PUBLIC_URL` in `.env` and restart, so status callbacks and the request-flow auth URL point at the tunnel.

## Pointing SignalWire at it

In the dashboard, on the demo number (or SIP address) that receives the caller's leg: set the call handler to an external SWML script and give it `https://<tunnel>/inbound`. Swap the path to `/inbound/twostep` or `/inbound/request-flow` to test the other flows; nothing else changes.

For the outbound leg, set the child SIP endpoint's calling handler to `https://<tunnel>/outbound` so calls the ATA originates route through the whitelist.

The two-step flow needs `KIDDYPHONE_DEAD_SIP_URI` to point at a SIP endpoint that exists in the space but is registered nowhere, so a connect toward it rings until timeout. Verify it has zero registered bindings before testing; an endpoint that answers destroys the hold.

## The experiments

Everything the server sees is appended to `evidence/requests.ndjson`, one JSON line per event, and mirrored to stdout.

**U5, the request body.** Place one call per flow. The captured `body` field is the authoritative record of what the platform sends. The code extracts identity defensively (`call.from`, `call.from_number`, top-level `from`) precisely because this shape was unconfirmed; once the evidence is in, tighten `src/identity.js` to the real keys and note the answer below.

**U4, the response budget.** Set `DELAY_MS` (or append `?delay=5000` to the handler URL) and raise it stepwise: 0, 2000, 5000, 10000, 20000. For each step place a call from a whitelisted number and watch whether the connect still happens. The first step where the call dies brackets the budget. Evidence timestamps plus the platform's retry behavior in the capture log are the measurement. Reset `DELAY_MS=0` when done.

**Two-step viability.** Call from a whitelisted number against `/inbound/twostep`. The capture line tagged `/inbound/twostep#update` records the REST result. A 2xx with the child ringing afterward proves the customer's design end to end; an error there is the finding that the update cannot reach a parked unanswered leg.

**Blocked caller experience.** Call from a number not on the whitelist. The caller should never see a connected state and the child's device should never ring. Confirm on the caller's handset; the server side alone cannot prove this (U1b remains open on the relay side too).

## Findings

Fill in as the live tests run.

| Question | Answer | Evidence |
|---|---|---|
| U5: request body keys | **SETTLED 2026-08-10.** Top-level `call` object: `call_id`, `node_id`, `segment_id`, `call_state` (arrives as `created`, leg unanswered), `direction`, `type`, identity duplicated as both `from`/`to` and `from_number`/`to_number`, `headers`, `project_id`, `space_id`; plus top-level `vars` and `envs`. | `evidence/requests.ndjson` 00:24:19 line |
| Single webhook flow works end to end | **CONFIRMED 2026-08-10.** Caller held in ringback unanswered, exactly one webhook invocation and one call ID per call, answered at device pickup. connecting +0.8s after webhook, connected at answer, disconnected on hangup, all on `status_url`. | 00:41:40 to 00:41:54 lines |
| U4: response budget | OPEN. No delay probing done yet. | delay step where the call died |
| REST `update` lands on a parked unanswered leg | OPEN. Two-step not yet exercised live. | `#update` capture line |
| Request-flow works on an unanswered leg | OPEN. | |
| Outbound leg behavior | OPEN. Child endpoint calling handler not yet pointed at `/outbound`. | |
| Blocked caller sees no connected state | OPEN. All live calls so far came from the whitelisted number. | caller handset |

Two traps found on the way, both worth carrying into any customer document:

1. **The space SIP domain carries a `domain_identifier` suffix.** A `connect` toward `sip:user@demo.sip.signalwire.com` fails with a misleading `400 "No valid devices" / "is not a registered endpoint"`; the working domain was `demo-4855c2ba739e.sip.signalwire.com`, queryable at `GET /api/relay/rest/sip_profile`. Outbound calls from a device prove nothing about registration; only inbound delivery needs a live binding. Same family as correction C9.
2. **The DID call handler silently reverted once** from `relay_script` back to `relay_context` while `call_relay_script_url` kept its value (suspected stale dashboard tab save). Symptom: caller hears dead air, webhook never fetched. Verify `call_handler` with a fresh GET when calls stop arriving.

## What this deliberately does not do

No `answer`, no `play`, no `record` anywhere. Media on an unanswered leg forces an answer and an answered call is a billed call (D16). The silent decline and a voicemail box cannot coexist on one call; that product decision (still unconfirmed with the customer) belongs to KiddyPhone, not to this code.

The webhook is now in the call path (D17). If this server or the tunnel is down, calls fail. A production deployment owns that availability commitment; this POC does not pretend to.

Whitelist entries live in `.env` for the POC. Production entries come from KiddyPhone's datastore; the module boundary (`src/whitelist.js`, no SDK or transport imports) is designed so that swap touches nothing else.

## Layout

```
src/whitelist.js   identity decision, D12/D13 closed, never throws
src/identity.js    defensive extraction from the (U5-unconfirmed) webhook body
src/docs.js        SWML document builders, answer_on_bridge everywhere
src/rest.js        Send Call Commands: update a live call with new SWML
src/capture.js     evidence log, one ndjson line per event
src/server.js      the webhook server and the entrypoint
test/              offline suites: node --test
```
