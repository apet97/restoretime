# PASS-02 — Recovery engine

Branch `pass-02-engine`, branch point `f10cb48`. Node 22.23.1.

## 1. How this pass was produced

Two implementers built the engine independently from the identical brief, in isolated worktrees.
Both delivered all 47 docs/13 IDs. This report's author judged them, chose one, merged the better
parts of the other, corrected a blueprint error found by live probing, and then adjudicated an
adversarial review.

### Candidate comparison

| Criterion | Candidate A | Candidate B | Chosen |
|---|---|---|---|
| Revalidation (docs/07 §7, ADR-006) | Re-checks a subset; skips P-LOCK-REG and P-BILL drift — self-declared gap | Re-runs the **full** preflight with the plan's choices and compares every outcome (`plannedRequest`, resolution, warnings, blockers, action-required) | **B** |
| DS-02's 404 case | Replaced the assertion with 400/`"501"` after finding an unknown entry id is not a 404 | Kept the documented 404-with-no-code case by probing `workspaces.get` on an unknown workspace | **B** |
| IT-07 | Reported **partial** (403 case unreachable) | Complete | **B** |
| Task lookup | `tasks.get` | `tasks.list` (unaffected by the R24 error-shape problem below) | **B** |
| Tests | 192 in 24 files | 198 in 22 files | **B** |
| Live evidence file | Recorded its DS-02 finding in `evidence/` | — | **A** |

B won on criterion 1. Its full-preflight revalidation is what ADR-006 actually requires; A's
subset would let a plan execute carrying a warning that is no longer true. I verified B's five
highest-risk implementations by reading the code before deciding: the claim SQL is docs/07 §6
verbatim including the lease clause; the `iterPages` bound is exactly
`page === maxPages && hasNextPage`; outcome classification is ordered timeout → transport →
5xx → 4xx; the create request carries `customFields` and never `customFieldValues`; and the client
is built with `timeoutInSeconds: 30`. B also solved the one-transaction uninstall problem cleanly —
deleting an installation row touches no ciphertext, so the cascade bypasses the async encryption
wrapper and does all four deletes in one synchronous better-sqlite3 transaction.

Both candidates' commits are preserved: B's six per-layer commits are cherry-picked onto this
branch, and every later change is a separate commit on top.

### The blueprint error this pass found

Neither candidate found it, because the blueprint told both of them the wrong thing.

`docs/03 §2`, `docs/04`, and `docs/07 §2–§3` all said a gone project is a **404** from
`projects.get`. It is not. Probed live on 2026-08-08 by creating a project, archiving it, deleting
it, and reading it back with the addon token:

```
GET /workspaces/{ws}/projects/{deleted id}  ->  400 {"message":"Project doesn't belong to Workspace","code":501}
```

Both candidates implemented `statusCode === 404` alone, so on the real platform **P-PROJ-GONE could
never fire**: a deleted project — the most common reason a recreation needs help — would have
surfaced as "Clockify could not be reached; try again" instead of the replacement picker.

Recorded as **R24** in `docs/01-evidence-baseline.md`, written up in
`evidence/error-shapes-2026-08-08.md`, corrected in docs/03, docs/04, docs/07 and docs/11, and
fixed in `src/clockify/preflight-data.ts`. The mapping is scoped to that one lookup, where
`workspaceId` + `projectId` are the only inputs and "doesn't belong to Workspace" has exactly one
cause. `tests/integration/project-gone.test.ts` pins it with five cases, two of which prove the
narrowing does **not** swallow an unrelated 400 code or a 5xx.

The same probe wave settled two more error shapes: an unknown **workspace** returns a 404 with an
entirely empty body (the code-absent case R15 records, and the one DS-02 now exercises), while an
unknown **route** returns 404 with body code `3000` — so "404" and "no body code" are independent
conditions, and neither may be inferred from the other.

The addon token correctly refused `PROJECT_WRITE` (`401 "Addon … does not have permission
PROJECT_WRITE"` — the manifest declares `PROJECT_READ` only), so the create/archive/delete steps
used the operator's dev API key. The probe project was removed.

## 2. Fixture provenance and sanitization

Thirteen files copied from
`~/Downloads/api-testing-restoration/time-entry-deleted-webhook/sanitized-payloads/` into
`tests/fixtures/webhook/`:

| Fixture | Source | Used by |
|---|---|---|
| `s1_baseline_deleted.json` | DSWH1 | CT-01 |
| `s2_rich_entry_deleted.json` | DSWH1 | normalization spot-check |
| `s9_running_deleted.json` | DSWH1 | CT-04 (auto-stopped case — see deviations) |
| `ENTRY_DSWH2_S2.json` | DSWH2 | CT-05 |
| `ENTRY_DSWH2_S12_updated.json` | DSWH2 | CT-02 |
| `ENTRY_DSWH2_tiebreak_run1.deleted.json` | DSWH2 | CT-04 (genuine running case) |
| `ENTRY_S2.deleted.json` | DSWH3 | markup-shaped description spot-check |
| `ENTRY_DSWH2_S4_{ascii,empty,html,newlines,tabs,unicode}.json` | DSWH2 | CT-03 |

Verified independently by this author, not taken on trust:

```
$ grep -EIrl "authToken|X-Addon-Token|X-Api-Key|Bearer |eyJ[A-Za-z0-9_-]{10,}" tests/fixtures/webhook/
$ echo $?
1                      # no matches

$ gitleaks detect --source . --no-git
no leaks found
```

`gitleaks` did initially report one hit — a throwaway boot-smoke encryption key inside a
**discarded PASS-01 worktree** under `.claude/`, never reachable from `main` and never pushed. The
worktrees were removed and the scan is clean. It is a useful reminder that docs/15 lists a CI
secret scan as gate 6 and CI does not yet have one; that belongs to PASS-04's ops wiring and is
recorded there.

## 3. docs/13 coverage

All 47 IDs implemented and passing. `npm run test` reports 217 tests in 23 files (the extra tests
above the ID count are the regressions added from the adversarial review, §5).

| ID | Test | Result |
|---|---|---|
| UT-N01, UT-N02 | `tests/unit/deleted-entry.test.ts` | pass |
| UT-P01…UT-P12, UT-P14…UT-P16 | `tests/unit/preflight.test.ts` | pass |
| UT-P13 | `tests/unit/recreate.test.ts` | pass |
| UT-F01 | `tests/unit/fidelity.test.ts` | pass |
| UT-S01, UT-S02 | `tests/unit/plan.test.ts` | pass |
| UT-A01 | `tests/unit/policy.test.ts` | pass |
| UT-X01 | `tests/unit/escape-html.test.ts` | pass |
| UT-M01 | `tests/unit/errors.test.ts` | pass |
| UT-L01 | `tests/unit/store-entries.test.ts` | pass |
| CT-01…CT-05 | `tests/contract/webhook-fixtures.test.ts` | pass |
| IT-01, IT-02, IT-06, IT-09, IT-10 | `tests/integration/webhook-ingestion.test.ts` | pass |
| IT-03, IT-12 | `tests/integration/claim.test.ts` + route-level race in `api-walkthrough.test.ts` | pass |
| IT-04, IT-05, IT-08, IT-13 | `tests/integration/mutation.test.ts` | pass |
| IT-07 | `tests/integration/authorization.test.ts` | pass |
| IT-11 | `tests/integration/uninstall.test.ts` (end state **and** rollback atomicity) | pass |
| IT-14 | `tests/integration/preflight-truncation.test.ts` (preflight **and** reconcile halves) | pass |
| DS-01, DS-02, DS-03 | `tests/dev-smoke/` — run live against `developer.clockify.me` | pass |

### Rule coverage (docs/07 §3)

Every P-* rule maps to a test: P-PERM, P-TYPE (UT-P14), P-OWNER (UT-P07), P-RUN/P-RUN-END
(UT-P01), P-TIMER (UT-P15), P-PROJ-REQ (UT-P08), P-PROJ-GONE (UT-P02 + `project-gone.test.ts`),
P-PROJ-SUB (UT-P02, UT-F01), P-PROJ-ARCH (UT-P03), P-TASK-GONE/P-TASK-CTX (UT-P04),
P-TAG-GONE/P-TAG-REQ (UT-P05), P-TAG-ARCH (UT-P06), P-DESC (UT-P09), P-CF-* (UT-P12, UT-P16),
P-BILL (UT-P10), P-LOCK/P-LOCK-REG (UT-P11). P-SYS never branches and is asserted wherever a case
reads `result.warnings`.

## 4. Gate output

```
$ node -v
v22.23.1

$ npm ci
found 0 vulnerabilities

$ npm run typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.ui.json

$ npm run lint
> tsc -p tsconfig.lint.json && tsc -p tsconfig.lint.ui.json

$ npm run test
 Test Files  23 passed (23)
      Tests  217 passed (217)

$ npm run build
  dist/static/app.js  3.7kb

$ npm run test:dev-smoke            # live, developer.clockify.me
 ✓ DS-01 workspaces.get and customFields.listForWorkspace succeed and deserialize
 ✓ DS-02 400/501 for a completed entry without projectId; 404 (unknown workspace) maps with undefined
 ✓ DS-03 createForUser -> get -> delete round-trips with the app's request shape
 Test Files  3 passed (3)
      Tests  3 passed (3)

$ git diff --check
(clean)
```

The dev workspace was left as found: a post-run scan of all ten users' entries and all 36 projects
found zero `RT-PROBE-` leftovers.

## 5. Adversarial review

An independent reviewer read the diff, verified the load-bearing SDK claims in source, and ran the
gates. It reported **no blocking findings** and nineteen others. **All nineteen were addressed:
eighteen fixed, one rejected with evidence.**

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| RT-01 | high | A page-bound baseline read after the claim was won and the plan CONSUMED threw out of the route: bare 500, and the row sat in RECREATING for the whole lease. | **Fixed.** `entries.releaseClaim` restores the exact pre-claim state and the route returns 503 with the documented message. Only `BaselineTruncatedError` releases — it is guaranteed to precede the create. Anything thrown at or after the create deliberately does **not** release: the outcome is unknown, so the lease expiring is the honest path (ADR-007). Regression: `api-walkthrough.test.ts` asserts 503, state IDLE, no claim token, and **no attempt row** (docs/08 invariant 4). |
| RT-02 | high | The reconcile half of IT-14 did not exist, and a comment claimed it lived in a file where it did not. | **Fixed.** Added: a stub returns full pages past page 10 on `listForUser`; the reconcile stays AMBIGUOUS, reports the bound, and adopts nothing. Comment corrected. I also ran the reviewer's suggested grep for comments asserting cross-file guarantees — the three remaining ones all verify true. |
| RT-03 | med | A truncated reconcile still incremented the check counter, so three bound-hitting checks could unlock "mark as not created" — inviting a duplicate entry. | **Fixed.** A truncated read never saw the whole list and is not evidence, so it no longer counts. Regression asserts `checks === 0` and the row still AMBIGUOUS after a truncated check. |
| RT-04 | med | No immediate reconcile after an AMBIGUOUS create; ADR-007 says "Reconcile immediately once, then lazily". | **Fixed.** The recreate route runs one check before responding and returns the resulting entry state. |
| RT-05 | med | Adoption never closed the attempt row (outcome stayed AMBIGUOUS, `new_entry_id` NULL), violating docs/08 invariant 2, and skipped the docs/07 §8 verification read. | **Fixed.** `finishAdoptedAttempt` writes SUCCESS + `new_entry_id` + the diff, on both the auto-adopt and explicit-resolve paths. The verification read cannot undo an adoption: a failure records "verification read unavailable", the same rule IT-13 pins for the create path. |
| RT-06 | med | An explicit project or task **removal** left fidelity FULL, though docs/07 §10 counts a drop as ADJUSTED. | **Fixed.** An explicit drop of a value the source had now sets `hasAdjustment`. Three regressions, including one asserting an untouched plan is still FULL. |
| RT-07 | med | `/api/options` did not paginate — a workspace with 300 projects silently showed 200 in the replacement picker. | **Fixed.** All three pickers use the same bounded `collectPaged` helper as preflight and surface the bound as 503 rather than truncating. |
| RT-08 | med | P-CF-OPT only checked `DROPDOWN_SINGLE`, and the P-CF-WRITE "NUMBER: numeric" validity condition was never checked. | **Fixed.** Both dropdown types are checked (per element for multi-select), and a non-numeric value for a NUMBER field becomes ACTION_REQUIRED at preflight instead of a 4xx at confirm. Two regressions. |
| RT-09 | low | `impliedBillable` ignores the effective project's own billable default, so P-BILL can miss a silent override. | **Rejected.** The implementation matches docs/07, which defines the implied value as *what the workspace defaults imply* (`defaultBillableProjects`). Project-level interaction has never been observed — R12/probe A5 proved the workspace-flag case only — and **R20 makes it unprobeable**: workspace settings are immutable via the API (405 code `3000`), so `onlyAdminsCanChangeBillableStatus` cannot be toggled on either workspace to test it. The reviewer's alternative (warn whenever either setting is present) deviates from docs/07 in the other direction and would fire on every non-admin recreation in such a workspace. LV-07 exists to close exactly this; carried there. |
| RT-10 | low | The consume-race loser flipped the row to FAILED with no attempt row. | **Fixed.** Uses the same `releaseClaim` as RT-01. |
| RT-11 | low | `resolve-ambiguous` accepted any fingerprint-matching entry, including one that predated the attempt. | **Fixed.** The candidate must be absent from the attempt's baseline (docs/07 §8 — "new" means "not in the baseline") and must belong to the entry's owner (ADR-004). |
| RT-12 | low | Auto-adoption recorded `recreated_by` as the entry owner, not the acting viewer. | **Fixed.** `ReconcileInput.recreatedBy` is now separate from `userId` (whose list is read). |
| RT-13 | low | "Installation broken" was stored as `status='INACTIVE'`, indistinguishable from a user disabling the addon, though docs/10 §8 shows different notices. | **Fixed.** Added `installations.broken_at` (add-only, in the unmerged 0002). A reinstall clears it. Two regressions, including one asserting `status` stays ACTIVE when the token is rejected. |
| RT-14 | low | The P-CF-OPT "keep the original value" choice was labelled ADJUSTED although the value is unchanged. | **Fixed.** A user input equal to the source value is a keep, not a substitution. **This changed a currently-passing assertion in UT-P16** — that test pinned a label docs/07 §10 does not describe, so this is correcting a wrong test, not weakening a failing one. A new sibling test pins that picking a *different* option is still ADJUSTED. |
| RT-15 | low | The mark-not-created window accepted an old *attempt* as a substitute for an old *last check*. | **Fixed.** Gated on the latest reconcile only, per docs/07 §8. A wrongly declared "not created" leads straight to a duplicate, so the stricter reading is the safe one; docs/07 was not amended. |
| RT-16 | low | The "any other thrown value is a bug: crash-log it" branch returned AMBIGUOUS with no log. | **Fixed.** `onUnexpectedError` is wired to the route logger; the outcome stays AMBIGUOUS. |
| RT-17 | low | Dead exports: an `isAddonTokenInvalid` re-export, plus `fetchBaseline`/`executeCreate` exported with no external consumer. | **Fixed.** All removed; `noUnusedLocals` then caught the now-unused import. |
| RT-18 | low | User-facing custom-field messages printed raw field ids. | **Fixed.** `CustomFieldDef` carries `name`, sourced from `customFields.listForWorkspace`. |
| RT-19 | low | Test-strength: IT-03 raced the store rather than the route; IT-11 proved the end state, not atomicity; the `status` list filter was cast, not validated. | **Fixed.** Added a route-level two-parallel-confirm test asserting exactly one create and a 200/409 split; added an IT-11 case that forces the second delete to fail and asserts the first rolled back; `status` is validated against the lifecycle states and an unknown value is dropped. |

The reviewer separately confirmed clean: the claim SQL and its lease comparison; no permanently
unclaimable state; every result write token-fenced; no automatic retry of a Clockify write at any
level (the SDK forbids POST in `retryableMethods` at construction); ingestion as one transaction,
status-independent, with a body/claims mismatch giving 400 and no row; revalidation genuinely
producing STALE; identity read only from verified claims with non-admin lists filtered by
`owner_id`; no token, webhook body, description, or custom-field value reachable in a log line;
fixtures sanitized; no dependency or terminology violations.

## 6. Deviations from the pass file

| Deviation | Reason |
|---|---|
| CT-04 uses the DSWH2 tie-break running fixture, not `s9_running_deleted.json` | That file is the auto-stopped artifact (`currentlyRunning:false`), which W12's tie-break disproved as a running-delete. Both files are copied and exercised. |
| `recreation_plans` gains `choices_json` and `action_required_json` beyond docs/08's column list | docs/07 §7 revalidation re-runs the preflight with the plan's original choices; without persisting them the rule is not implementable. |
| `Viewer` gains `addonId` | Every route loads the installation, which is keyed `(workspace_id, addon_id)`. Still read from verified claims only. |
| `installations.broken_at` added to migration 0002 | RT-13. 0002 is unmerged, so editing it is legitimate — AGENTS.md rule 18 bars editing an *applied* migration. |
| `attemptRecreation` / `runReconcile` orchestration functions in `recreate.ts` | Composes the documented pieces once instead of duplicating the sequencing between the route and its tests. |
| `projects.get` treats 400 body code `501` as "gone" alongside 404 | R24 — the blueprint was wrong; see §1. docs/03, docs/04, docs/07 and docs/11 were corrected rather than worked around. |

## 7. Known limitations, handed forward

1. **`GET /api/entries` does a project and task lookup per row.** The four workspace-level lookups
   are shared across rows as the pass file requires, but the per-entry ones are not deduplicated by
   `projectId`. Fifty listed entries across fifty distinct projects is ~100 Clockify calls for one
   list request. **PASS-04**, whose scope names performance sanity.
2. **CI has no secret-scan gate** although docs/15 lists one (gate 6). `gitleaks` is installed
   locally and this pass was scanned by hand. **PASS-04** (ops wiring).
3. **P-BILL cannot be fully verified offline** (RT-09). **LV-07**.
4. **`--passWithNoTests` is now off `test` and `test:dev-smoke`.** It remains on `test:e2e` and
   `test:live` until PASS-03 and PASS-05 fill those directories. PASS-05 must still assert that
   LV-01…LV-10 actually ran.
5. **Custom-field item shape is SDK-typed only.** The dev workspace holds zero custom fields, so
   DS-01 proves the call succeeds and deserializes, not that items match. **LV-08** (R23).
6. `dismiss`/`undismiss` and `GET /api/options` have no dedicated route tests; the reconcile
   throttle's skip branch is covered, its not-stale branch is exercised only indirectly.
