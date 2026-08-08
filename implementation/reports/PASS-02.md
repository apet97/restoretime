# PASS-02 — Recovery engine — report

## Fixture provenance and sanitization check

Copied from `~/Downloads/api-testing-restoration/time-entry-deleted-webhook/sanitized-payloads/`
into `tests/fixtures/webhook/` (already-sanitized campaign payloads; verified again on copy):

| Fixture file | Source | Used by |
|---|---|---|
| `s1_baseline_deleted.json` | `DSWH1/s1_baseline_deleted.json` | CT-01 |
| `s2_rich_entry_deleted.json` | `DSWH1/s2_rich_entry_deleted.json` | normalization spot-check |
| `s9_running_deleted.json` | `DSWH1/s9_running_deleted.json` | CT-04 (auto-stopped case, see Deviations) |
| `ENTRY_DSWH2_S2.json` | `DSWH2/ENTRY_DSWH2_S2.json` | CT-05 |
| `ENTRY_DSWH2_S12_updated.json` | `DSWH2/ENTRY_DSWH2_S12_updated.json` | CT-02 |
| `ENTRY_DSWH2_tiebreak_run1.deleted.json` | `DSWH2/ENTRY_DSWH2_tiebreak_run1.deleted.json` | CT-04 (running case) |
| `ENTRY_S2.deleted.json` | `DSWH3/ENTRY_S2.deleted.json` | XSS-shaped description spot-check |
| `ENTRY_DSWH2_S4_ascii.json` | `DSWH2/ENTRY_DSWH2_S4_ascii.json` | CT-03 |
| `ENTRY_DSWH2_S4_empty.json` | `DSWH2/ENTRY_DSWH2_S4_empty.json` | CT-03 |
| `ENTRY_DSWH2_S4_html.json` | `DSWH2/ENTRY_DSWH2_S4_html.json` | CT-03 |
| `ENTRY_DSWH2_S4_newlines.json` | `DSWH2/ENTRY_DSWH2_S4_newlines.json` | CT-03 |
| `ENTRY_DSWH2_S4_tabs.json` | `DSWH2/ENTRY_DSWH2_S4_tabs.json` | CT-03 |
| `ENTRY_DSWH2_S4_unicode.json` | `DSWH2/ENTRY_DSWH2_S4_unicode.json` | CT-03 |

Sanitization check: `grep -EIrl "authToken|X-Addon-Token|X-Api-Key|Bearer |eyJ[A-Za-z0-9_-]{10,}"`
against the source files before copy, and again against the copied `tests/fixtures/webhook/`
directory after copy — zero matches both times (exit code 1, no output).

## Rule coverage table (docs/07 §3 P-* → test IDs)

| Rule | Test ID(s) |
|---|---|
| P-PERM | `preflight.test.ts` "P-PERM defense in depth" |
| P-TYPE | UT-P14 |
| P-OWNER | UT-P07 |
| P-RUN / P-RUN-END | UT-P01 |
| P-TIMER | UT-P15 |
| P-PROJ-REQ | UT-P08 |
| P-PROJ-GONE | UT-P02 |
| P-PROJ-SUB | UT-P02 (substitution path), UT-F01 (ADJUSTED) |
| P-PROJ-ARCH | UT-P03 |
| P-TASK-GONE / P-TASK-CTX | UT-P04 |
| P-TAG-GONE / P-TAG-REQ | UT-P05 |
| P-TAG-ARCH | UT-P06 |
| P-DESC | UT-P09 |
| P-CF-KEEP / P-CF-WRITE / P-CF-OPT / P-CF-REQ | UT-P16 |
| P-CF-GONE | UT-P12 |
| P-BILL | UT-P10 |
| P-LOCK / P-LOCK-REG | UT-P11 |
| P-SYS | included unconditionally in `runPreflight`'s `warnings` (`SYSTEM_DIFFERENCES`); not
  independently gated by a test ID since it never branches — asserted implicitly wherever a
  `preflight.test.ts` case reads `result.warnings` |

## Gate outputs (exact, this run)

Environment: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`; `node -v` → `v22.23.1`.

```
$ npm ci
added 98 packages, and audited 99 packages in 5s
25 packages are looking for funding
found 0 vulnerabilities

$ npm run typecheck
> restoretime@0.1.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.ui.json
(no output — clean)

$ npm run lint
> restoretime@0.1.0 lint
> tsc -p tsconfig.lint.json && tsc -p tsconfig.lint.ui.json
(no output — clean)

$ npm run test
> restoretime@0.1.0 test
> vitest run tests/unit tests/contract tests/integration
Test Files  22 passed (22)
     Tests  198 passed (198)

$ npm run build
> restoretime@0.1.0 build
> tsc -p tsconfig.build.json && mkdir -p dist/store/migrations dist/static && cp src/store/migrations/*.sql dist/store/migrations/ && esbuild src/ui/app.ts --bundle --outfile=dist/static/app.js --format=iife --target=es2020
  dist/static/app.js  3.7kb
⚡ Done in 13ms

$ npm run test:dev-smoke   # with CK_DEV_WORKSPACE_ID/CK_DEV_ADDON_ID/CK_DEV_ADDON_TOKEN set from the
                           # captured developer-environment installation
Test Files  3 passed (3)
     Tests  3 passed (3)
# DS-01, DS-02, DS-03 all green against developer.clockify.me (live).
# Re-run with the three env vars unset: all 3 tests still pass, each logging
# "blocked — no valid developer installation (missing CK_DEV_WORKSPACE_ID)" — the blocked path is
# a real, passing test, never a silent skip.
# Post-run verification: scanned every workspace user's time entries for an "RT-PROBE-" prefixed
# description — 0 found. The workspace was left exactly as it was found.
```

`npm run test:e2e` and `npm run test:live` are unchanged (`--passWithNoTests`, PASS-03/PASS-05 fill
them); not run here since they have no bearing on this pass.

## Docs/13 coverage table

See the final chat message for the complete ID → file:test-name → pass/fail/not-implemented table
(same content, kept in one place per the harness instructions).

## Deviations from the pass file

1. **CT-04 fixture substitution.** The pass file's fixture-copy list names `DSWH1/s9_running_deleted.json`
   for the "running" case, but that file's payload has `currentlyRunning:false` (it is the
   auto-stopped artifact W12 documents, not a genuinely-running delete). CT-04 instead uses
   `DSWH2/ENTRY_DSWH2_tiebreak_run1.deleted.json` (`currentlyRunning:true, end:null`), which is
   also in the copy list. `s9_running_deleted.json` is still copied and exercised as a second
   normalization case (W12's auto-stopped path) — both are covered, neither is dropped.
2. **`recreation_plans.choices_json` added to migration 0002.** docs/08's documented column list
   for `recreation_plans` has no `choices` column, but docs/07 §7 revalidation requires rerunning
   preflight with the *same* choices that produced the plan — unimplementable without persisting
   them. Added as a NOT NULL JSON column. `action_required_json` was similarly added (ACTION_REQUIRED
   items have to be stored somewhere for the detail/confirm views). Both are implicit gaps in the
   documented schema, not a redesign of anything docs/08 does specify.
3. **`platform/verify.ts` `Viewer` gains `addonId`.** Every `/api/*` route needs `addonId` to load
   the correct installation row (`installations` PK is `(workspace_id, addon_id)`), and the
   component JWT already carries it (`ClockifyAddonClaims.addonId`). PASS-01's `Viewer` didn't
   include it because PASS-01 had no route that made a Clockify call. `tests/unit/require-viewer.test.ts`
   updated accordingly, plus a new test asserting a token with no `addonId` claim is rejected.
4. **DS-02's 404 probe targets `workspaces.get` on an unknown workspace id, not `timeEntries.get`
   on an unknown entry id.** Live-probed against `developer.clockify.me` in this pass: a nonexistent
   *sub-resource* id inside a real, known workspace (time entry, project, tag, task — all tried)
   returns 400 `{"…doesn't belong to Workspace", code:501}`, never a 404. The only genuine
   code-absent 404 found is an unknown *workspace* id, which matches docs/03 §6's own description
   of the 404 case ("Clockify does not have this workspace or route"). This is a correction to an
   assumption, backed by a fresh live probe, not a deviation from any PROVED evidence-baseline fact.
5. **P-PROJ-GONE and P-PROJ-SUB (and similarly the task-side rules) are implemented as one unified
   code path in `preflight.ts`**, rather than as two separately-branching rules: an explicit
   substitute that turns out not to exist reuses the "gone" ACTION_REQUIRED. docs/07's table gives
   no separate outcome for "the user's substitute is itself invalid," and this is the only
   consistent reading of "validate it exists" for P-PROJ-SUB.
6. **`recreate.ts` and `routes.ts` add an `attemptRecreation`/`runReconcile` orchestration layer**
   that composes the store + Clockify-client pieces docs/07 specifies (claim, baseline, create,
   verify, reconcile, adopt) into single functions. The pass file's "Domain" section names the
   individual pieces; the orchestration was necessary to make IT-04/05/08/13 and the API routes
   testable without duplicating the sequencing logic in two places (recreate.ts and routes.ts).
7. **IT-06 added**, though it is absent from the pass brief's own per-layer build-order enumeration
   (which lists IT-01..05,07..14 but skips IT-06). It is present in docs/13 and the completion
   contract, so it is implemented — `tests/integration/webhook-ingestion.test.ts`.

## Self-review — weakest part of this work

The custom-field preflight rules (P-CF-*) are the least battle-tested corner. The resolution order
(source value → current default → user input, with dropdown-option staleness and required-field
handling all interacting) is the most intricate part of `preflight.ts`, and while UT-P16 covers
every documented branch, the *combinations* — e.g., a required dropdown field whose source value is
both stale (not in `allowedValues`) and equal to a value the workspace no longer offers as a
default — are not exhaustively tested. If a case doesn't fit neatly into "keep / write / opt / req"
it will still get *some* answer from the code, but I have not proven that answer against a
docs/07-table row for every combination, only the ones the table names directly.

The lazy-reconcile trigger in `GET /api/entries/detail` (ADR-010) is also under-tested relative to
its complexity: it is exercised once, happily, in `api-walkthrough.test.ts`. Failure modes — the
lazy reconcile itself hitting a truncated list, or the client being briefly unavailable mid-detail-view
— degrade to "render the pre-reconcile state" by design (`try { } catch { }` in `handleDetail`), but
that fallback path has no dedicated test.

## Limitations / could not do

- Could not run `npm run test:live` (LV-suite) — it requires `CK_LIVE_API_KEY`/`CK_LIVE_WS` against
  the sacrificial production-shaped workspace, which is out of scope for this pass (PASS-05) and I
  had no such credentials in this environment regardless.
- `GET /api/entries`'s per-row preflight summary only runs for `IDLE`/`FAILED` rows (states where
  "Recreate" is an available action). `RECREATING`/`AMBIGUOUS`/`RECREATED`/`DISMISSED` rows get
  `preflightSummary: null` in the list response. This keeps the list endpoint from making
  `O(rows)` extra Clockify calls for rows where a preflight summary is not actionable information,
  but it is a scope decision the pass file doesn't make explicit either way.
- No UI renders any of this (explicitly out of scope — PASS-03).
