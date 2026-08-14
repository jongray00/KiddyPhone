# KiddyPhone on SignalWire

A child-safe phone line, built three ways on SignalWire. A parent keeps a whitelist
of who may call the child and who the child may call. The application never answers
a call to make that decision: an allowed caller is bridged the moment the child picks
up, a blocked caller never sees a connected state, and billing starts at the bridge.

All implementations sit behind one test lab you drive from a real cell phone.

## Where the SignalWire code is

Each app keeps its SignalWire integration in a `signalwire/` folder. If you read
nothing else, read these twelve files. Everything outside them is plumbing.

### RELAY Realtime SDK (`apps/relay/src/signalwire/`)

The application holds a WebSocket to SignalWire and decides on the live call object.

| File | What it shows |
| --- | --- |
| `app.js` | `SignalWire()` client, `voice.listen` on inbound and outbound topics, orderly drain |
| `handler.js` | The heart: receive the offer, authorize while the leg stays unanswered, then `call.connect` with the child as the peer, or decline. Answering is reserved for the one configurable exception (voicemail on ring-out); the decision itself never answers |
| `connect-guard.js` | Containment for SDK realities on this package: re-offer storms during slow lookups, duplicate collapse, one connect per flight with initiator/joiner roles so a re-delivered offer never hangs up the live bridge |

Supporting code stays one level up in `apps/relay/src/`: whitelist normalization
(`identity.js`), fault and deadline plumbing, process guards, config validation.

### Server SDK (`apps/serversdk/src/signalwire/`)

The same decision on `@signalwire/sdk`, the current server SDK — the migration
target. Kept deliberately small so the semantic differences stand out.

| File | What it shows |
| --- | --- |
| `app.js` | `RelayClient` with contexts, the single `onCall` handler, orderly drain |
| `flow.js` | The decision on the new surface: identity from the device descriptor, `connect()` resolving at the ACK with the outcome arriving as a `calling.call.connect` event, 409 stand-down |

### SWML (`apps/swml/src/signalwire/`)

The space fetches instructions from a webhook at call time; the decision is rendered
as an SWML document.

| File | What it shows |
| --- | --- |
| `docs.js` | The SWML documents. One parameter carries the design: `connect` with `answer_on_bridge: true` |
| `rest.js` | Send Call Commands API: replacing a parked leg's document mid-call (the two-step flow) |
| `arm.js` | Pointing the DID or SIP endpoint at a scenario over the REST API, verified with a fresh GET |
| `static.js` | The no-tunnel fallback: compile the whitelist into a document and host it on the space itself (`/api/fabric/resources/swml_scripts`) |
| `caller.js` | REST-originated test calls |

Supporting code stays in `apps/swml/src/`: the webhook HTTP server, whitelist,
webhook body parsing, evidence capture, and the console backend.

## Layout

```
apps/relay/          RELAY Realtime implementation (@signalwire/realtime-api)
  src/signalwire/      the SDK integration (read this)
  src/                 supporting logic
  live/                live-call harness: provisioning, smoke rows, guided
                       listener, evidence.mjs long-ring/busy matrix
  test/                unit tests (88)
apps/serversdk/      Server SDK implementation (@signalwire/sdk)
  src/signalwire/      the SDK integration (read this)
  test/                unit tests (6)
apps/swml/           SWML implementation
  src/signalwire/      the SignalWire artifacts (read this)
  src/                 webhook server and support
  test/                unit tests (64)
console/             the demo shell: gateway, landing page, line-test console
shared/              env loading and per-space provisioning helpers
docs/                findings and review reports
```

## Running the lab

```
npm install
npm run gateway     # http://127.0.0.1:8790
```

One hostname serves the whole lab: the gateway is the only listener facing
outward, and it reverse-proxies the RELAY console under `/relay/` and the SWML
app under `/swml/`. On a hosted deploy the public origin is read from the
environment and the SWML webhook base (`<origin>/swml`) is injected into that
app, so armed handlers, `status_url` callbacks, and the request-flow `/auth`
URL all point at reachable addresses without a tunnel or a hand-written
`PUBLIC_URL`. Set `PWPOC_PUBLIC_ORIGIN` to advertise a different origin.

The landing page connects a SignalWire space (the bundled demo space works out of
the box), offers the RELAY or SWML implementation, and launches the one you pick.
Credentials are validated with a read-only `sip_profile` probe, stored server-side,
and never sent to the browser.

The demo the lab is built around: your cell phone plays grandma or a stranger, and
the child's handset is a web phone living in the page. Start a guided card, dial the
number it shows, and watch the signal ladder and the billing ledger prove the
promise on a real carrier leg.

```
npm test            # both apps' unit suites
npm run console     # relay line-test console alone (http://127.0.0.1:8787)
```

Live topology on a space is created by `apps/relay/live/setup.mjs` (everything is
`pwpoc-` prefixed) and removed by `teardown.mjs`. DIDs you already own can be
adopted for the demo: their routing is snapshotted and restored on teardown.
