# KiddyPhone connect-before-answer POC — live results

**Package:** `@signalwire/realtime-api@4.2.1` (exact pin, the package KiddyPhone runs)
**Run:** 2026-08-10 (UTC 2026-08-11 00:12–00:22), SignalWire demo space
**Build:** clean-room from the master context only; the prior solution's code in
`kiddyphone-verify/` was not read (its SOLUTION.md summary was seen before the clean-room
decision, and its claims were treated as unverified)
**Unit tests:** 73/73 pass offline (`npm test`)
**Live calls placed:** 6, one per matrix row, zero retries, zero extra calls

## The one-line result

Connect-before-answer works on the exact package KiddyPhone runs today: every path
(inbound allow / no-answer / deny, outbound allow / deny, PSTN both directions) behaved
as the recommendation predicts, with billing starting at the bridge and unanswered or
declined calls costing $0.00.

## Matrix evidence

Logs: `live/rowN.log` (JSONL, wall-clock offsets). CDRs: `live/rowN-cdr.json`, pulled
from `/api/voice/logs` (the LAML Calls endpoint does not surface these relay legs
promptly — use voice/logs).

| Row | Path | Result | Billing evidence |
|---|---|---|---|
| 1 | Inbound allow, child answers (SIP→SIP) | **PASS.** 1 offer, 1 call id. Connect issued 1503 ms after the offer (injected 1.5 s auth delay). App never called `answer()`. A-leg went `created → ringing → answered` at the child's pickup moment (child answered +7371 ms, A-leg answered event +7395 ms). | A-leg `duration_ms 11521`, **`billing_ms 5209`** — 6.8 s of ringing was free; only the bridged window billed. |
| 2 | Inbound allow, child never answers | **PASS.** 1 offer. Connect failed at the 10 s dial timeout with `connectState:'failed', failedReason:'noAnswer'` (a plain object with NO code — classified FAILED, caller released). Caller saw dial failure, never answered. | All four legs `billing_ms: null, charge: 0`. A fully-rung unanswered call costs nothing. |
| 3 | Inbound deny (stranger) | **PASS.** Decision at 1.5 s, `hangup('decline')` on the unanswered leg. Caller's dial rejected with `reason:'decline'` ~3.1 s after dialing; no connected state ever. 1 offer — the decline also acknowledged inside the 5 s window. | A-leg `billing_ms: null, charge: 0`. |
| 4 | Outbound allow (ATA digits → PSTN DID) | **PASS.** First live exercise of the outbound path in any configuration. `sip:12083799823@…` arrived on the outbound topic; the handler normalized the digits to `+12083799823`, whitelisted it, and dialed `connectPhone` with the configured E.164 caller id. Child-sim answered the DID leg; A-leg answered at bridge. | PSTN B-leg `duration_ms 9326`, **`billing_ms 5160`**, charge $0.03382 "Outbound Voice Minutes" — carrier billing also starts at the bridge. |
| 5 | Outbound deny | **PASS.** `+19998887777` extracted, denied, declined unanswered. | Both legs `billing_ms: null, charge: 0`. |
| 6 | Inbound allow via PSTN (DID caller → SIP child) | **PASS.** PSTN From arrived as bare `+12083799823` (phone-type leg), whitelisted as PSTN. Child answered; A-leg answered at bridge. | PSTN A-leg (`relay_pstn_call`) `duration_ms 11868`, **`billing_ms 5425`**, charge $0.0066 "Inbound Voice Minutes" — billed only the bridged window, on a real carrier-billed leg, with the app never answering. |

## Master-context open items this run closes

- **"Confirm the one-offer behavior with the connect issued at ~1.5 s, not immediately."**
  Confirmed. Rows 1, 2, 4, 6 all issued the connect ~1.5 s after the offer (simulating
  KiddyPhone's stated auth time) and every row saw exactly 1 offer, 1 call id.
- **"Test the outbound path"** (was KiddyPhone's item; never exercised live). Done, row 4
  and row 5, including the ATA-digits-as-SIP-user shape and deny.
- **U8 on PSTN, reconfirmed on fresh DIDs:** billing starts at bridge on carrier legs in
  both directions (rows 4 and 6).
- **U1b partially:** the caller's leg (SDK-originated) rejected with `dialState:
  'failed', reason: 'decline'` and was never answered; `billing_ms null`. A physical
  handset display was still not observed — that residue of U1b stands.

## Identity formats observed live (feeds D12/D13 handling)

- SIP via domain app: From arrives verbatim, user and host preserved:
  `sip:pwpoc-parent@demo-pwpoc-inbound.dapp.signalwire.com` (recorded by the row 3
  calibration call in `live/observed-from.json`).
- PSTN: From arrives as bare E.164 `+12083799823` on a `phone`-type leg.
- B-leg to SIP from a PSTN caller presents `sip:+12083799823@sip.signalwire.com`.

## Error shapes captured live on 4.2.1 (all absorbed by the fault boundary)

- `{ code: '404', message: 'Call not found' }` — plain object, string code, printed by
  the SDK's own internal logger as `Execute error`; thrown at our `hangup()` after the
  far end already ended. Absorbed by `safeHangup` (rows 1, 4, 6).
- Connect failure with **no code at all**: `{ connectState: 'failed', failedReason:
  'noAnswer', callId, nodeId, segmentId }` (row 2). Anything code-less classifies as
  FAILED → teardown, which is the correct action for it.
- Dial failure at the caller: `{ dialState: 'failed', reason: 'decline' | 'busy', … }` —
  also a plain object, `code: null`. A denied caller gets `decline`; a caller whose
  connect failed gets `busy`.

## New SDK defect found (add to the R-list for the SDK team)

**`Call.waitForDisconnected()` on 4.2.1 returns the `disconnect` method itself**
(`waitForDisconnected() { return this.disconnect; }` in the shipped bundle) — it never
waits for anything, and `await`-ing it yields a function. Verified by source inspection
and pinned by `test/sdk-surface.test.mjs`. The POC uses `disconnected()` instead.

## What this POC deliberately does NOT do

- No `answer()` anywhere in the flow — so no greeting, no rejection message, no
  voicemail. That is the design's stated cost (D16). Note: the space's CDR ledger shows
  a separate earlier run (not this POC; `smoke-deny` at 23:21 UTC, from the prior
  solution) with a "Text to Speech" charge of $0.0004 and `billing_ms: null` on an
  unanswered leg — evidence that early-media TTS without answering may be possible.
  This POC did not test that claim; it is worth a deliberate follow-up before telling
  KiddyPhone they must choose between silence and billing on the deny path.
- No migration to `@signalwire/sdk` (sequencing per master context section 6).
- Nothing on KiddyPhone's project: all numbers here are demo-space (D21 stands — the
  mechanism transfers; confirm billing on their account before quoting figures).

## Demo space state after teardown

- 3 `pwpoc-*` domain applications: deleted (204), inventory matches pre-run.
- 2 purchased DIDs (`+12083799823` pwpoc-child-did, `+12083799834` pwpoc-inbound-did):
  **release is platform-locked until 2026-08-25** (422: "purchased too recently").
  Left named `pwpoc-*`, pointed at contexts with no listener (inert). Run
  `node live/teardown.mjs` again after 2026-08-25 to release them.
- SIP endpoints: one endpoint `pwpoc-dead` (id `15259f9f-f133-4a89-91f9-9064e9deb412`)
  appeared during the run window. **This POC did not create it** (it created no SIP
  endpoints at all; the manifest in `live/topology.json` is exhaustive) and therefore
  did not delete it. The name suggests someone was testing the "dead endpoint" idea from
  the support thread, possibly a concurrent session. Flagged for the owner to claim.

## Repo map

```
src/            the implementation (identity, faults, deadline, connect-guard,
                lifecycle, process-guards, handler, config, app)
test/           73 unit tests incl. child-process crash-survival proofs and the
                SDK-surface tripwire
live/setup.mjs      recreate the topology (reuses locked pwpoc DIDs, buys only shortfall)
live/teardown.mjs   delete manifested resources + diff inventory against pre-run
live/smoke.mjs      one matrix row per invocation: node live/smoke.mjs <1..6>
live/rowN.log       JSONL timelines per row; rowN-cdr.json the billing evidence
ui/                 the line-test console: npm run console -> http://127.0.0.1:8787
```

## The line-test console (`npm run console`)

A local web UI over the same harness: six scenario cards ("Grandma calls, the child
picks up" / "A stranger calls" / …), each placing one real call via live/smoke.mjs and
streaming every RELAY event into a live signal ladder (caller | platform·app | child),
followed by a per-leg billing ledger where only the post-bridge window fills amber.
Expectation checklists evaluate automatically from the event stream. Topology
build/teardown and the 73-test suite run from the header. Binds 127.0.0.1 only.
Validated end-to-end 2026-08-10: topology rebuilt through the console (reusing the
locked DIDs, no new purchases) and scenario 3 re-run live through it — 4/4 checks
green, $0.00 both legs (7th and final live call of this engagement).
