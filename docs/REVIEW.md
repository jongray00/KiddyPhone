# KiddyPhone POC — full requirements & application review

**Date:** 2026-08-10 (evening)
**Scope:** the clean-room POC in this repo (src/, test/, live/, ui/) reviewed against the
master context's full requirement set: product promises P1–P3, defect register D1–D21,
corrections log C1–C12, open investigations U1–U8, and the open-items ledger.
**Method:** every claim below is traced to a unit test, a live call log (`live/rowN.log`),
a CDR (`live/rowN-cdr.json`), or explicitly marked as not verified. ~12 live calls were
placed across the engagement; nothing in this report rests on an untested assertion.

**Verdict shorthand:**
✅ fully addressed, evidence in hand · 🟡 addressed with a named residual ·
📦 contained (cannot be cured in this codebase, risk boxed in) · 🔴 open, owner named ·
⚪ not applicable to this architecture

---

## 1. Product requirements

### P1 — No charge for calls nobody answers ✅ (🟡 for the dollar figures)
Connect-before-answer defers billing to the bridge. Live evidence across every path:
allowed+answered bills only the bridged window (row 1: 11.5s lifetime, 5.2s billed);
allowed+unanswered bills nothing on any of four legs (row 2); declined bills nothing
(rows 3, 5); carrier PSTN legs behave identically in both directions (rows 4, 6:
`Outbound/Inbound Voice Minutes` charged only for the post-bridge window). A 30.8s call
with 19.7s of real handset ringing billed $0 (slow-check run).
**Residual:** all figures are demo-space (D21). The mechanism transfers; the numbers must
be re-confirmed on KiddyPhone's project before being quoted to them as billing guarantees.

### P2 — Blocked callers never see a connected state ✅ (🟡 one observation gap)
Deny path hangs up with `decline` on the leg still in `created`. The caller's dial fails
with `reason: "decline"` (~3s at a 1.5s check, ~12s at a 10s check); no answered state
ever reaches the caller; zero billing. Verified on 4 live deny calls.
**Residual (U1b):** the caller in every test was SDK-originated. A physical handset's
display on decline has still not been observed. Cheap to close now: dial the inbound
domain app from the registered SIP phone as a non-whitelisted caller and look at the
screen.

### P3 — The call is answered only when the child accepts ✅
Proven with a human: Jon answered the registered SIP phone and the A-leg flipped to
`answered` within 3ms of the pickup (`app:bridged` +6.44s, pickup +6.43s). The app calls
`answer()` nowhere; the handler test suite asserts an answer-count of zero on every path.
CDR `billing_ms` starts at that moment, so the call record reflects the conversation.

---

## 2. Defect register (D1–D21)

| # | Defect | Verdict | Evidence |
|---|---|---|---|
| D1 | 409 dropping live calls | ✅ | `classify()` → STOOD_DOWN, teardown false; handler 409 path contains no hangup. No 409 occurred in any live run — the single-flight prevents generating them. Unit: connect-guard + handler tests. |
| D2 | One call, many offers/ids | ✅ | Connect (or decline) acknowledges inside the window. 1.5s check → exactly 1 offer (rows 1–6). 10s check → 3 offers, same call id, collapsed to one connect / one decline (slow-check runs). Intent key excludes call id by construction. |
| D3 | Offer fan-out multiplying auth lookups | ✅ | Memoized authorizer, in-flight joining. Live: 3 handler runs → decisions resolve within 2ms of each other → 1 lookup. Harness auto-scales cache TTL past the lookup time; the TTL > p99 rule is documented (see §6, edge 3). |
| D4 | `hangup()` on 409 tearing down the winner | ✅ | The rule is structural: STOOD_DOWN/GONE return before any hangup. Unit test named for the outage. |
| D5 | Errors not `Error` objects, no stack | ✅ | `toFault()` boundary; live-captured plain-object 404s absorbed in rows 1, 4, 6. |
| D6 | Error code arrives as a string | ✅ | `relayCode()` numeric normalization everywhere; unit-tested against the live shape `{code:'409'}`. |
| D7 | Timeouts resolve `undefined` | ✅ | `withDeadline` + `expectResult` on every SDK await; undefined-resolution → caller released (unit-proven; not forceable live). |
| D8 | Bare `Symbol` rejections | ✅ | Symbol-safe describe/fault path, proven at handler and process level (child-process test). |
| D9 | New SDK swallows coded errors (`{}`) | ⚪ | Not present on 4.2.1. Flagged in migration notes: route through `client.execute` there (C7). |
| D10 | Un-awaited rejection kills the worker | ✅ | Process guards absorb; child-process baseline proves default Node dies, guarded worker survives both live rejection shapes and keeps serving. |
| D11 | No drain; `disconnect()` orphans calls | ✅ | Drain order enforced; raw disconnect **refused** above zero active calls (throws). Unit-tested; console shutdown uses the drain. |
| D12 | Whitelist ignores SIP domain | ✅ | Anchored user+host match; all four adversarial addresses denied in tests, including the `…signalwire.com.attacker.com` suffix attack. Live deny of a wrong-domain caller: covered by unit tests only (see §6, edge 7). |
| D13 | Whitelist rejects ordinary caller-ID formats | ✅ | E.164 normalization: 6 ordinary formats admitted in tests; live PSTN From arrived as bare `+1208…` and matched. Junk/null never throws, always denies. |
| D14 | Source not published for 4.2.1 | 📦 | Exact version pin + `sdk-surface` tripwire test asserting every member used. The tripwire caught a real bug (see §5, R9). Upstream opacity cannot drift under the app silently. |
| D15 | Package EOL, no fixes coming | 📦 | Nothing depends on an upstream fix; every defect neutralized at the app boundary. Port seam to `@signalwire/sdk` documented (identity/faults/guard modules are SDK-free). |
| D16 | No greeting/rejection/voicemail without answering | 🟡 | Honored as designed (silent decline). **Open contradiction:** the space ledger shows a prior session's unanswered leg with a $0.0004 TTS charge and `billing_ms: null` — early-media rejection may be possible. Needs one deliberate test, then the voicemail question to the customer (never asked). |
| D17–D19 | Webhook in call path / response budget / no mid-call control | ⚪ | SWML-only concerns. This POC keeps full RELAY control (it is how the real-phone answer demo works). The parallel SWML POC tracks these. |
| D20 | The load-bearing behavior is undocumented | 🔴 | **The largest open product risk.** Connect-before-answer deferring the answer and acknowledging the offer is verified behavior, not specified behavior. Owner: SignalWire platform team — confirm intended-and-preserved before a child-safety billing guarantee rests on it. This POC adds evidence, not documentation. |
| D21 | Measurements from the demo space | 🔴 | Unchanged. Re-run rows 1, 3, 6 on KiddyPhone's project when access exists. |

---

## 3. Corrections-log compliance (C1–C12)

Checked that this codebase and its documents do not repeat any previously-corrected error:

- **C1** (string codes on both packages): numeric comparison is the only comparison used. The owed *customer* correction to Brian remains unsent — comms item, §7.
- **C2** (uuid deprecation warning): install notes say exactly one unrelated warning. ✔
- **C3** (20.56s new-id boundary): never quoted 24–25s anywhere. ✔
- **C4/C6/C7** (migration realities): recorded in migration notes; no code here wraps `call.connect()` for error handling on the new package. ✔
- **C8** (`call.context` ≠ topic on the new SDK): v4's `context` getter verified against the shipped bundle to carry the payload context; the console routes per-topic `listen()` anyway, which survives migration. ✔
- **C9** (`host` option fails): omitted, with a comment at the construction site. ✔
- **C10** (wait units): `waitFor` not used; `disconnected()` used instead — which also dodges the new R9 bug. ✔
- **C11** (snake_case recording options): no recording in this POC. ✔
- **C12** (`onCall` replaces handlers on the new SDK): v4 per-topic emitters verified in the bundle; flagged as a migration hazard in app.js comments. ✔

---

## 4. Open investigations (U-series)

| Item | Status |
|---|---|
| U1 hangup on unanswered leg | ✅ re-confirmed live, all deny paths |
| U1b declined caller's handset display | 🔴 still unobserved — now trivially testable with the registered phone |
| U2 connect on unanswered leg | ✅ re-confirmed live, 6 distinct runs |
| U3 re-offer lifecycle | ✅ 5s cadence re-confirmed (offers at ~2.0/7.0/12.1s, same call id). The 20.56s new-id boundary was never reached because acknowledgment always landed first — consistent with, but not a re-measurement of, C3 |
| U4 SWML webhook response budget | ⚪ SWML POC's item (still open there) |
| U5 SWML request body shape | ✅ settled by the SWML session (top-level `call` object) |
| U6 can an external party present an arbitrary SIP From | 🔴 platform team; not testable from here |
| U8 billing starts at bridge | ✅ re-confirmed on fresh DIDs, both PSTN directions, plus the human-answered run |
| Outbound path never exercised | ✅ closed — rows 4 and 5 were its first live exercise, allow and deny |
| One-offer with connect at ~1.5s | ✅ closed — every 1.5s-check run saw exactly 1 offer |

---

## 5. SDK findings to report upstream (not yet filed)

R1–R8 from the master context stand. This engagement adds:

- **R9 (new):** 4.2.1 `Call.waitForDisconnected()` returns the `disconnect` method itself
  (`return this.disconnect`) — awaiting it yields a function, it never waits. Pinned by
  the `sdk-surface` test so an upstream fix is noticed. Workaround: `disconnected()`.
- Supporting live captures for R2/R4: code-less connect failures
  (`{connectState:'failed', failedReason:'noAnswer'}`), plain-object 404s during cleanup,
  and the caller-side distinction `decline` vs `busy`.

**Owner: Jon** — none of R1–R9 has been filed with the SDK team yet.

---

## 6. Edge-case inventory

| # | Edge case | Coverage |
|---|---|---|
| 1 | Check time > first re-offer (5s) | ✅ live at 10s: duplicates collapsed, both paths |
| 2 | Check time > new-call-id boundary (20.56s) | 🟡 unit-covered (intent key excludes call id; stale-id connect → GONE). Not live-run; the console clamps the simulated check at 15s deliberately |
| 3 | Auth cache TTL shorter than lookup time | ✅ identified during review and fixed: harness scales TTL past the lookup. Design rule for KiddyPhone: **memoizer TTL must exceed auth-API p99** or re-offers trigger fresh lookups mid-check |
| 4 | Auth API down / lookup throws | ✅ fails closed (deny, no answer, no crash) — unit; not simulated live |
| 5 | Caller abandons during the check | 🟡 connect/hangup on the dead leg → 404 → GONE, nothing to tear down (unit + live-captured 404s in cleanup). Not deliberately staged live |
| 6 | Child busy / rejects / unregistered | 🟡 noAnswer verified live; device-side busy/reject and unregistered-endpoint (400) shapes classified as FAILED → caller released, unit only |
| 7 | Adversarial SIP identities (D12 suite) | ✅ unit (4/4 denied); live spoofed-From blocked by U6 being untestable from here |
| 8 | null/undefined/junk identity | ✅ unit: denies, never throws |
| 9 | Empty whitelist at boot | ✅ refuses to start (unit) |
| 10 | Worker crash mid-call | ✅ child-process proof: guarded worker survives; uncaught exception routes to drain |
| 11 | Shutdown with calls in flight | ✅ drain order unit-tested; straggler force-hangup at deadline |
| 12 | Multi-worker deployment | 🔴 **not tested, by design honest:** the single-flight lock is in-process. Two workers can still race one call; the 409-stand-down rule is the guarantee there. If KiddyPhone runs >1 worker, that classification path is load-bearing and deserves a live two-worker test |
| 13 | Concurrent distinct callers | 🟡 registry/guard are keyed per logical call and handle it by construction; never live-tested in parallel |

---

## 7. Outstanding items ledger (nothing here is code)

**Jon (customer comms):** correct the C1 sentence sent to Brian · send the amendment
narrowing SWML to optional · answer (or relay) the customer Amhaus's unanswered question · brief
the customer before the amendment lands · ask the customer the voicemail question (D16) · decide D12
disclosure with Luca and Justin · file R1–R9 with the SDK team.
**KiddyPhone:** auth-API p99 under burst (the console's 10s control is the demo of why) ·
silent-decline vs voicemail decision.
**Platform team:** D20 blessing · U6 answer.
**Operational:** two `pwpoc-` DIDs release-locked until **2026-08-25** (`teardown.mjs`
again after that date) · `pwpoc-dead` endpoint belongs to the SWML POC (resolved, not an
intruder) · demo-space topology currently **built** (console shows the live state).

---

## 8. Application (console) feature review

| Feature | Verdict | Notes |
|---|---|---|
| Scenario 1 — inbound allow | ✅ | Live 4×: simulator, real phone answered (1.5s check), real phone at 10s check, plus Jon's own click. Checks adapt to the chosen check time |
| Scenario 2 — inbound no-answer | ✅ | Live 2×: simulator; real phone 10.2s ring, $0 |
| Scenario 3 — inbound deny | ✅ | Live 3× incl. the 10s storm run |
| Scenario 4 — outbound allow (PSTN) | 🟡 | Live 1× at 1.5s. Not re-run under a slow check (each run costs ~3–4¢ carrier) |
| Scenario 5 — outbound deny | 🟡 | Live 1× at 1.5s; slow-check variant not run |
| Scenario 6 — PSTN inbound | 🟡 | Live 1× at 1.5s; slow-check variant not run; costs real minutes per run |
| Child-device selector | ✅ | Simulator ↔ real endpoint; full `sip_profile` domain (dodges the bare-domain 400 trap); real path verified by ring + by answered bridge |
| Whitelist-lookup-time control | 🟡 | 1.5s and 10s live-verified; the 4s edge option exists but has not been run |
| Signal ladder (live SSE) | ✅ | Draws offers, decision, connect, bridge arrow in real time; verified by screenshot during a live run |
| Billing ledger | ✅ | Per-leg duration vs `billing_ms` bars from `/api/voice/logs`; leg labels disambiguated |
| Expectation checks / verdicts | ✅ | Auto-evaluated from the stream; storm-aware for rows 1–2; rows 3–6 checks are delay-independent by construction |
| Topology build / teardown | ✅ | Both exercised through the console; DID reuse on rebuild (no repeat purchases); status chip reflects live REST state |
| Unit-test runner | ✅ | Endpoint verified to run and complete; suite is 73/73 at last full run |
| Run history | ✅ | Cards load their last recorded run from `live/rowN.log` on selection |
| Single-job lock | ✅ | One live action at a time, 409 otherwise — deliberate |
| Security posture | ✅ | Binds 127.0.0.1 only; `.env` never sent to the browser |
| Known gaps | — | No scenario uses the real phone as the *caller* (would close U1b — recommend adding manual-dial instructions or a "waiting for your call" mode) · test-runner results stream as raw text, no pass/fail badge · teardown leaves scenarios unable to run until rebuild (chip communicates it) |

---

## 9. Bottom line

Every pain point that can be fixed **in code on the package KiddyPhone runs today** is
fixed, unit-tested against the exact live failure shapes, and demonstrated with live
calls — including under a 10-second whitelist stress that lands two re-offer waves
mid-check. The three product promises are proven end-to-end, once with a human answering
a real phone.

What is *not* closed is exactly what cannot be closed from this repo: the platform's
blessing of the undocumented behavior (D20 — the single biggest risk to the
recommendation), KiddyPhone-project billing confirmation (D21), the spoofed-From question
(U6), one product decision (voicemail vs silent decline, sharpened by the early-media TTS
evidence), and a stack of customer-comms items that predate this POC. Those have named
owners in §7. Recommended next actions, in order: (1) D20 confirmation from the platform
team, (2) the U1b handset check — five minutes with the registered phone, (3) the C1
correction and amendment to KiddyPhone, (4) a two-worker race test if production runs more
than one worker.
