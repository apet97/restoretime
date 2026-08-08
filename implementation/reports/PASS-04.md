# PASS-04 — Hardening report

Status: COMPLETE. All checklist groups landed, gates green, one commit per group.

## Repository / branch

Worktree: `/Users/15x/Downloads/WORKING/addons-me/restoretime/.claude/worktrees/agent-a14401cb2bcc3abd0`

Branch: `worktree-agent-a14401cb2bcc3abd0` (assigned by the harness). The pass file asks for
`pass-04-hardening`; not renamed mid-pass to avoid churn — recorded as a deviation (see below).

## Files changed or added this pass

```
docs/14-operations.md                            — Performance section (documented p95 budget)
implementation/reports/PASS-04.md                — this report
.github/workflows/ci.yml                         — gitleaks secret-scan gate (docs/15 gate 6)
src/api/routes.ts                                — logger dep, metrics emission, N+1 fix wiring,
                                                     N8 message fixes (no-client / already-claimed /
                                                     plan-consumed / attempt-error / transport)
src/clockify/errors.ts                           — safeErrorSummary (log-safe error summarizer)
src/clockify/preflight-data.ts                   — ProjectTaskCache (N+1 fix)
src/clockify/recreate.ts                         — RT_TEST_CRASH_MID_ATTEMPT crash injection
src/ingest/webhook.ts                            — WebhookHandlingResult.inserted (metrics)
src/metrics.ts                                   — new: emitMetric + the 13 documented names
src/server.ts                                    — safeErrorSummary wiring, webhook metrics,
                                                     ApiRouteDeps.logger

tests/e2e/xss-proof.test.ts                      — UT-X01 extension (item 3)
tests/integration/ambiguous-soak.test.ts         — IT-04 extension (item 6)
tests/integration/concurrency-workers.test.ts    — IT-03 extension (item 4)
tests/integration/workers/claim-worker.mjs       — real worker_threads claim racer (item 4)
tests/integration/error-message-sweep.test.ts    — IT-19, N8 sweep (item 11)
tests/integration/lease-fencing-drill.test.ts    — IT-12 extension (item 5)
tests/integration/log-audit.test.ts              — IT-15, N3 log audit (item 1)
tests/integration/metrics.test.ts                — IT-18, docs/14 metrics (item 10)
tests/integration/performance.test.ts            — IT-17, N+1 proof + p95 budget (item 9)
tests/integration/permission-negatives.test.ts   — IT-07/IT-09 extension (item 2)
tests/integration/revalidation-drill.test.ts     — IT-16, STALE-plan no-mutation proof (item 7)
tests/unit/errors.test.ts                        — UT-M02 safeErrorSummary unit coverage
docs/13-testing.md                               — matrix extended in place: IT-03/04/07/09/12
                                                     extended cells; IT-15..IT-19 and UT-M02 added;
                                                     E2E section registers xss-proof.test.ts
docs/12-security.md                              — threat-model Test column: log leakage / token
                                                     exposure → IT-15; XSS row notes the E2E proof
```

All ten PASS-04 test files carry their docs/13 ID (extended or new) in a header comment, so
`grep -rEno "IT-[0-9]+|UT-[A-Z][0-9]+" tests/` finds every one of them — this matrix is the
authoritative index, not the file list above.

## Gate commands run, in order, with real output

Node: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`; `node -v` → `v22.23.1`.

```
$ npm ci
added 105 packages, and audited 106 packages in 3s
found 0 vulnerabilities

$ npm run typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.ui.json && tsc -p tsconfig.e2e.json
(clean, no output)

$ npm run lint
> tsc -p tsconfig.lint.json && tsc -p tsconfig.lint.ui.json && tsc -p tsconfig.lint.e2e.json
(clean, no output)

$ npm run test
> vitest run tests/unit tests/contract tests/integration
 Test Files  32 passed (32)
      Tests  291 passed (291)
   Duration  6.54s (transform 726ms, setup 0ms, collect 4.66s, tests 21.04s, environment 3ms, prepare 1.94s)
(well under the 5-minute budget)

$ npm run build
  dist/static/app.js  51.8kb
⚡ Done in 11ms

$ npm run test:e2e
> vitest run tests/e2e
 Test Files  3 passed (3)
      Tests  18 passed (18)
   Duration  1.44s
```

Total: 309 tests (291 offline + 18 e2e), all green. `gitleaks detect --source . --log-opts="fc90a64..HEAD"`
against this pass's own commit range: `11 commits scanned... no leaks found`.

## Coverage table — docs/12 threat model rows

| Threat | Boundary | Test (post-PASS-04) |
|---|---|---|
| Forged webhook | 1 | IT-02 (`tests/integration/webhook-ingestion.test.ts`) — unchanged |
| Webhook replay | 1 | IT-01 (`tests/integration/webhook-ingestion.test.ts`) — unchanged |
| Tampered component token | 2 | SDK tests + IT-07, **extended**: `permission-negatives.test.ts` "expired token" and "token signed for a different addon key" sweeps, all 12 `/api/*` routes |
| User spoofing (`userId` in body) | 2 | IT-09, **extended**: `permission-negatives.test.ts` "forged/other user (neither owner nor admin)" sweep, all entry-scoped routes + the admin-filter-ignored case on `GET /api/entries` |
| Workspace spoofing | 2 | IT-09, **extended**: `permission-negatives.test.ts` "forged/cross-workspace viewer" sweep, all entry-scoped routes + `GET /api/entries` + bulk-preflight/bulk-recreate no-existence-leak cases |
| IDOR (entry id of another user) | 2 | IT-07, **extended**: same sweep as above |
| Regular user reads another's entry | 2 | IT-07, **extended**: same sweep |
| Admin demoted between view and POST | 2 | IT-07, **extended**: `permission-negatives.test.ts` "demoted admin" describe block — proves the 403-not-404 asymmetry is confined to `/api/entries/recreate` (the one route with `deniedIsForbidden`) and every other route still answers 404 |
| Source id tampering (plan for another entry) | 3 | UT-S01 (`tests/unit/plan.test.ts`) — unchanged |
| Stale plan (deps changed) | 3 | UT-S02, **extended by IT-16** (`tests/integration/revalidation-drill.test.ts`) — proves at the HTTP level that a STALE plan never issues the Clockify create call (call-log assertion, not just a response-shape check) |
| TOCTOU (dep deleted after revalidate) | 3 | IT-05 (`tests/integration/mutation.test.ts`) — unchanged |
| Concurrent recreation | 2/3 | IT-03, **extended**: `tests/integration/concurrency-workers.test.ts` — 8 real `node:worker_threads` workers, separate SQLite connections, racing one row; exactly one winner. Plus `tests/integration/lease-fencing-drill.test.ts` — a real crash (via `RT_TEST_CRASH_MID_ATTEMPT`) through the actual HTTP route, then reclaim + fenced-write-rejection |
| Duplicate mutation (blind retry) | 3 | review, **substantiated**: `client.timeEntries.createForUser` is called exactly once (`src/clockify/recreate.ts` `executeCreate`, single `await`, no loop); the SDK itself structurally forbids configuring POST/PATCH as retryable (`clockify-sdk-ts-115/dist/esm/composed-fetch.js`: "POST and PATCH retries are not supported because their outcome may be ambiguous" — throws `TypeError` if attempted), and `buildClockifyClient` passes no custom `retryPolicy`, so the SDK's default (GET/HEAD/OPTIONS only) applies. Still LV-04 for the live confirmation docs/13 specifies |
| Ambiguous POST | 3 | IT-04, **extended**: `tests/integration/ambiguous-soak.test.ts` — one scripted sequence covering commit-lost, nothing-committed, a double-candidate, and (new) a double-adoption attempt across two different rows via the real `/api/entries/resolve-ambiguous` route → exactly one 409 |
| XSS via stored Clockify values | 2 | UT-X01, **extended**: `tests/e2e/xss-proof.test.ts` — description, project name, task name, tag names, owner name, and a custom-field value, driven through list, detail, the resolution widgets (a hostile `/api/options` project name in a real `<select>`), confirm, the success/diff view, and (direct-render) the bulk and FAILED/AMBIGUOUS result views. Asserts zero `<img>/<svg>/<script>/<iframe>` elements exist anywhere in the document, not just that text is escaped |
| SQL injection | 4 | review, **re-verified this pass**: every `src/store/*.ts` write/read uses `db.prepare` with named/positional parameters; the one dynamic SQL (`entries.ts` `list()`) only joins fixed clause strings, values always travel via bound params (`grep` swept for string-built SQL — none found) |
| **Sensitive log leakage** | all | **review → real test: IT-15** (`tests/integration/log-audit.test.ts`, N3) — the highest-value item per the pass brief; docs/12's Test column updated to `IT-15`. See "Log audit" below |
| Addon token exposure | 3 | review, **reinforced by IT-15**: `log-audit.test.ts` explicitly seeds a distinctive installation auth token and two real signed JWTs, drives a full scripted run, and asserts none of them appear in any captured log line |
| Uninstall data residue | 1/4 | IT-11 (`tests/integration/uninstall.test.ts`) — unchanged; already asserted the `recreation_plans`/`recreation_attempts` cascade counts before this pass, satisfying item 8 without a new test |
| Iframe embedding abuse | 2 | LV-01 — unchanged (live-only) |
| Token replay across addons | 2 | SDK tests, **extended**: `permission-negatives.test.ts` "token signed for a different addon key" sweep, all routes |

## Coverage table — docs/11 edge cases

All docs/11 rows carried a test ID into this pass (PASS-01…03); PASS-04 did not re-derive product
behavior for any of them (IMPLEMENTER.md: PROVED facts are inputs). The rows this pass materially
touched:

| Scenario | Test | PASS-04 change |
|---|---|---|
| Duplicate webhook delivery | IT-01 | unchanged; also exercised inside IT-15's (`log-audit.test.ts`) scripted run |
| Webhook for unknown installation | IT-02 | unchanged |
| Malformed webhook body | UT-N01 | unchanged; also exercised (`webhook_rejected`) in IT-18 (`metrics.test.ts`) |
| Running entry deleted | UT-P01 | unchanged |
| Description with `<`/`>` | CT-03 | unchanged; `xss-proof.test.ts` extends the same principle to project/task/tag/owner/CF fields the CT fixture doesn't cover |
| Emoji/Cyrillic/newline/tab descriptions | UT-N02, UT-X01 | UT-X01 extended (see threat table) |
| Duplicate recreation click (user + admin) | IT-03 | extended (see threat table — real worker threads) |
| Ambiguous create, entry committed / nothing committed / two candidates | IT-04 | extended into one scripted soak (see threat table) |
| Re-created entry deleted again | IT-06 | unchanged |
| Admin demoted between view and confirm | IT-07 | extended (see threat table) |
| Addon token rejected (401 code 4017) | IT-08, UT-M01 | unchanged; `safeErrorSummary` (new) never logs the rejected token or the raw Clockify body for this path either |
| Cross-workspace ID guessing | IT-09 | extended (see threat table) |
| Webhook redelivery after dismissal | IT-10 | unchanged |
| Workspace larger than the page bound | IT-14 | unchanged |
| Every other row (P-PROJ-*, P-TASK-*, P-TAG-*, P-CF-*, P-BILL, P-LOCK, P-TIMER, P-OWNER, P-TYPE, P-RUN, P-DESC, approval/invoice rows) | UT-P01…P16, UT-M01 | unchanged — pure domain-rule tests (`tests/unit/preflight.test.ts`, 50 tests), no I/O, nothing this pass's scope (adversarial/concurrency/log/perf conditions) touches |

## Performance numbers and the documented budget

Also written down in `docs/14-operations.md` §Performance (not only in the test file, per the
pass brief's "must be written down somewhere in-repo").

- Fixture: 5000 seeded `recoverable_entries` rows; 50 actionable (IDLE) across 5 distinct projects
  (10 rows/project), 4950 non-actionable filler rows (RECREATED). Only actionable rows trigger a
  preflight computation in `GET /api/entries` — seeding all 5000 as actionable would measure stub
  dispatch overhead at a scale unlikely to reflect a real "needs a decision" backlog, not the N+1
  fix.
- **N+1 proof** (`tests/integration/performance.test.ts`, test 1): a counting fetch stub asserts
  `GET /api/entries` issues **exactly 5** project lookups (one per distinct project), never 50, and
  **0** task-list calls. Verified this is load-bearing, not decorative: temporarily reverting the
  fix (dropping the `ProjectTaskCache` argument) made the same assertion fail with `10` calls per
  project (`50` total) — confirmed, then the fix was restored and re-verified green.
- **p95 budget**: `LOCAL_P95_BUDGET_MS = 150` (test 2, 15 requests). Measured p95 on the hardening
  machine: **~25–49 ms** across multiple runs — several times inside budget. This is a **local,
  stub-backed, in-process** number (no real Clockify network latency), not a production SLA;
  documented as such in both the test file and docs/14. Confirmed this number does NOT by itself
  catch the N+1 regression (it stayed under budget even with the bug reintroduced, ~41 ms) — the
  exact-call-count assertion is the one that actually enforces the fix; the p95 test is the
  "sanity" half the pass file asks for, not a substitute.

## Log audit: method and result

**Method.** `tests/integration/log-audit.test.ts` spies on `process.stdout.write` /
`process.stderr.write` for the duration of one scripted run (install → webhook ingest with
sentinel description + custom-field value → list → detail → a preflight failure whose underlying
Clockify error body is adversarially crafted to *echo* a sentinel → a recreate FAILED outcome whose
create-rejection body also echoes a sentinel → uninstall), then asserts none of five sentinel
values (description, custom-field value, the installation's Clockify auth token, the webhook JWT,
the install JWT) appear in any captured line.

**Result.** Passes. It is not decorative: this pass found and fixed a real leak vector in the
process. `ClockifyApiError.message` (`clockify-sdk-ts-115`) embeds the entire response body
verbatim (`"Body: " + JSON.stringify(...)`); five `onError` hooks in `src/server.ts` logged
`error: String(error)`, which calls `Error.prototype.toString()` and would print that body straight
into a log line if Clockify's error response ever echoed request data. Verified this concretely:
reverted one call site to `String(error)`, re-ran the test with a stub that returns a Clockify
error body containing the sentinel — the test failed, showing the sentinel in the captured log
line — then restored the fix (`src/clockify/errors.ts` `safeErrorSummary`, which logs
`{errorName, errorStatus, errorCode}` for a `ClockifyApiError` and never its `message`/`body`) and
re-confirmed green. `tests/unit/errors.test.ts` adds direct unit coverage of `safeErrorSummary`.

## Behaviors changed during hardening (and the evidence that required each one)

1. **`safeErrorSummary` replaces `String(error)` in every `server.ts` `onError` hook.**
   Evidence: the log-audit test failed with the old code once a Clockify error body was crafted to
   echo a sentinel (see above) — a genuine leak path, not a hypothetical.
2. **`ProjectTaskCache` dedupe in `fetchEntryWorkspaceState`, wired into `GET /api/entries` and
   `bulk-preflight`.** Evidence: the pass file's own carried-over PASS-02 finding ("fifty rows
   across fifty projects is ~100 Clockify calls"), confirmed and reproduced by
   `performance.test.ts`'s call-count assertion before the fix (10 calls/project instead of 1).
3. **Metrics module (`src/metrics.ts`) plus 13 emission points across `server.ts`/`routes.ts`.**
   No prior metrics existed. Evidence: docs/14 requires them; `metrics.test.ts` proves the exact
   name set (extra or missing counters both fail it — verified by disabling one emission point and
   watching the test catch it).
4. **Four user-facing message strings rewritten** (`no-client`, `already-claimed`,
   `plan-consumed`, `attempt-error`) to answer docs/02 N8's three questions distinctly per
   situation. Evidence: by inspection, all four previously reused one of two generic sentences
   ("Clockify connection is unavailable for this installation" / "Clockify could not be reached;
   try again") regardless of whether a mutation might already be in flight — most notably,
   `attempt-error` (an outcome-unknown state per ADR-007) shared its text with `revalidate-error`
   (a state that is safely "nothing happened"), which is actively misleading. Confirmed by
   `error-message-sweep.test.ts`, which asserts the fixed `attempt-error` text explicitly does
   *not* claim "nothing was created" while every genuinely-safe-to-retry message does.
5. **`RT_TEST_CRASH_MID_ATTEMPT` crash-injection flag added to `src/clockify/recreate.ts`.**
   Test-only, rejected unless `NODE_ENV==="test"` (same guard shape as the existing `RT_CHAOS_FETCH`
   flag). Added because IT-12's existing coverage (`tests/integration/claim.test.ts`) only proved
   the lease/fencing SQL primitives in isolation; the pass explicitly asks for a crash through the
   real handler.
6. **`WebhookHandlingResult.inserted` field added** (`src/ingest/webhook.ts`) so `server.ts` can
   distinguish `recoverable_created` from `webhook_duplicate` for the metrics.

No other behavior changed. Every existing test from PASS-01…03 still passes unmodified.

## Deviations

- Branch name: `worktree-agent-a14401cb2bcc3abd0`, not `pass-04-hardening` (harness-assigned; not
  renamed mid-pass).
- `gitleaks/gitleaks-action@v2` is wired without `GITLEAKS_LICENSE`. Verified: the action requires
  a license key only for **organization**-owned repositories, not personal-account ones (any
  visibility); docs/15 names the remote as `github.com/apet97/restoretime` (a personal account), so
  no license should be needed. If this repository is ever transferred to a GitHub organization, add
  `GITLEAKS_LICENSE` to the workflow step — noted inline in `.github/workflows/ci.yml`.

## Self-review: weakest part, and what could not be done

- **Weakest part**: the AMBIGUOUS-soak and metrics tests are long, multi-phase scripts (~250–350
  lines each) built from stateful fetch stubs with call counters and mutable flags. They are
  correct and each was verified to fail when the underlying fix was reverted, but their length
  makes them the least readable tests in this pass — a future reader has to trace stub state
  carefully. A cleaner design might extract a small shared "scripted scenario" test harness, but
  that is a refactor without a currently-failing test driving it, which AGENTS.md rule 15 and the
  pass's "no refactors without a failing test" scope rule both forbid doing speculatively.
- **`plan-consumed` (routes.ts) is unreachable through the current HTTP surface.** Traced this
  during the N8 sweep: `entries.claim()` and `plans.consumeActive()` run back-to-back inside
  `confirmPlan` with no `await` between them, and `better-sqlite3` is synchronous — so no other
  request can interleave in that gap within a single Node process. Any request replaying an
  already-consumed `planId` is caught earlier, by `isPlanUsable`'s fresh read of `plan.status`
  (the "stale" branch — proven by `revalidation-drill.test.ts`). This is a genuine finding, not
  a gap I chose not to close: the code path is real defense-in-depth (protects an invariant that
  would matter if the claim/consume ordering ever changed), the message text was still fixed to
  answer N8, and the underlying invariant it guards (`consumeActive` is exactly-once) is tested
  directly at the store layer in `error-message-sweep.test.ts`. Recorded here rather than forcing
  a synthetic "test" that doesn't reflect real request handling.
- **The error-message sweep (item 11) covered the highest-stakes strings (the recreate/confirm
  failure path) exhaustively, not every one of the ~50 `errorJson(...)` call sites in
  `routes.ts`.** The ones left alone are either (a) malformed-request responses no legitimate UI
  path can trigger (`"entryId is required"`, `"invalid body"`, etc. — the UI never sends these
  shapes) or (b) the existing "no existence leak" 404/403 pair, which is deliberately terse by
  security design (docs/09) and not really a "failure a legitimate user should be coached through."
  A full literal audit of all ~50 strings was not completed; the four fixed were chosen because
  they are the ones a normal, non-adversarial user can actually see during ordinary use of the
  highest-stakes action (confirming a recreation).
- **Uninstall purge (item 8)** needed no new test: `tests/integration/uninstall.test.ts` (IT-11,
  written in PASS-02) already asserted the `recreation_plans`/`recreation_attempts` cascade counts
  drop to zero alongside `recoverable_entries`, and that a second workspace's rows survive. Verified
  this by reading the test before writing anything new, to avoid a redundant/coverage-padding test
  (AGENTS.md rule 19).
- Did not attempt to change `implementation/DEPENDENCIES.md`; `gitleaks` was added as a CI Action
  only, per the brief's authorized exception.

---

## Adversarial review (added by the judging author)

An independent reviewer worked in its own worktree, ran every gate, and — unusually and valuably —
**proved its claims by reverting behaviour and re-running**. It confirmed as genuinely load-bearing:
IT-15 (reverting `safeErrorSummary` to `String(error)` made the sentinel reappear), the XSS proof
(switching a view to `innerHTML` failed it), and the N+1 request-scoping (making the cache a module
global failed four tests — closing the cross-tenant concern). It also traced the
`safeErrorSummary` generic-`Error` branch and showed no Clockify content can reach it, because the
SDK wraps every transport and parse failure as `ClockifyApiError`.

**No blocking or high findings. Seven others, all fixed.**

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| F1 | med | The process-parallelism drill raced a **duplicated copy** of the claim SQL, so it could not detect a regression in the real `claim()`. The reviewer proved it: deleting the entire claim predicate left `concurrency-workers.test.ts` green. | **Fixed.** The worker genuinely cannot import the TypeScript module (a `worker_threads` entry skips vitest's transform, and the `.js` specifier does not exist before a build), so the suite now pins the two SQL strings against each other after whitespace normalization, and additionally asserts the predicate still contains both docs/07 §6 clauses. Verified the same way the defect was found: dropping the lease clause from `claim()` now fails this test. |
| F2 | med | Two tests depended on real SDK retry backoff — 4.46 s and 2.92 s — violating this pass's own ">2 s wall-clock" rule, with ±20% jitter as a flake surface. | **Fixed.** Both stubs now return a non-retryable 400 instead of a 500/thrown `TypeError`. What each asserts is unchanged (an error body carrying a sentinel never reaches a log; revalidation fails before any create). 4.46 s → 0.75 s and 2.92 s → 0.32 s. |
| F3 | low | docs/13's IT-12 cell claimed the reclaim and fencing steps ran "through the real route"; only the crash does. | **Fixed.** The cell now says the crash goes through the route and the rest is proved at the store layer, and names why (route-level lease expiry would need an injectable clock). |
| F4 | low | `emitPreflightMetrics`'s docstring claimed every `runPreflight` call site emits; two do not. | **Fixed.** The docstring now states which sites emit and, more usefully, *why* the other two must not: counting the per-row list summaries would inflate the counter every time a user refreshed a list. |
| F5 | low | The log-audit header claimed to drive "every logging call site this app has"; several were undriven. | **Fixed both ways.** A rejected webhook delivery (workspace mismatch → 400) was added to the script, since the rejection path is where a raw payload would most plausibly leak; and the header now names the sites it does **not** drive, noting that they share the pinned helper — which is an argument, not a proof. |
| F6 | low | docs/13 and the XSS header said the payloads run "against the real bundle boot path"; that test imports `boot()` from source. | **Fixed.** Both now say the source path, and point at `component-flow.test.ts` as the test that boots the built bundle. |
| F7 | low | The permission sweep's "no row changed" assertion snapshotted only `recoverable_entries`. | **Fixed.** The snapshot now also captures plan statuses and the attempt count, so a refactor that consumed a plan before the access check would fail the sweep. |

Final gates after the fixes: typecheck, lint clean; **292 tests in 5.38 s**; build clean; **18 E2E**;
`git diff --check` clean; `gitleaks detect` reports no leaks.
