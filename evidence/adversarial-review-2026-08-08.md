# Adversarial review — 2026-08-08

Independent adversarial review of the blueprint (commit `030b3c6`) by the DeepSeek advisor, with
SDK source spot-checks. Verdict before fixes: **BLOCKED** (two release-blocking items). All
findings were adjudicated by the architect against evidence; every finding was valid in at least
its documentation dimension and was incorporated. No finding required an architecture change.

## Dispositions

| # | Finding | Severity | Disposition |
|---|---|---|---|
| 1 | `verifyClockifyToken` defaults `requireExpiration:false`; docs demanded `exp` without passing the option | high | Fixed: docs/03 §5 and PASS-01 now mandate `{requireExpiration:true}` (verified in SDK source) |
| 2 | Ambiguity protocol had no mandatory live verification | high | Fixed: LV-10 is now a hard release gate with a concrete chaos-fetch method (`RT_CHAOS_FETCH`, test-only); docs/13, PASS-05, docs/15, docs/16 updated |
| 3 | Invariant 1 said "one write" while PASS-02 specified two writes in one tx | med | Fixed: docs/05 invariant 1 now says one atomic transaction (insert + conditional lineage update) |
| 4 | Running-recreate can auto-stop the owner's current timer; no warning | med | Fixed: P-RUN rule, UI spec widget text, and edge-case row carry the single-timer warning |
| 5 | Bulk endpoints missing from the permissions enforcement table | med | Fixed: docs/09 gates bulk routes admin-only at the route plus engine backstop |
| 6 | Custom fields excluded from revalidation | med | Fixed: docs/07 §7 revalidates CF too; CF drift refreshes the plan (honesty, never gating) |
| 7 | P-LOCK specified against undefined setting semantics | low | Fixed: P-LOCK is warning-only, never parses dates, never blocks; rejection backstop enforces |
| 8 | Webhook tokens described as event-keyed; SDK model is path-keyed | low | Fixed: docs/03, docs/08, PASS-02 (verified `ClockifyLifecycleWebhookToken = {path, webhookType, authToken}`) |
| 9 | `timeApprovalEnabled`/`invoicingEnabled` absent from the SDK settings model | low | Fixed: R12 notes the model gap; preflight never depends on the untyped fields |
| 10 | `projectArchived` stored but unused | low | Fixed: dropped from `DeletedTimeEntry` (preflight re-checks; least data) |
| 11 | Fidelity edges (running choice; new required CF) | low | Fixed: docs/07 §10 clarifies running→running is FULL; new-required-CF surfaces as mapped FAILED |
| 12 | Log-leak verification over-claimed as CI step | low | Fixed: docs/16 cites the PASS-04 log-audit test |

## Reviewer-confirmed sound

SDK surface claims (webhook/component verifiers, `createForUser` route and model,
`workspaces.get` settings, `listForUser` params, installation store + codec, `isClockifyAdminRole`,
`getErrorCode`); claim SQL and uniqueness invariants; advisor's prior fixes (bounded reconcile,
double-adoption guard); the `/entities/*` feed ban; fixture availability; XSS and honesty rules.

## Verdict after incorporation

READY_FOR_IMPLEMENTATION (architect's assessment; the reviewer's two release blockers are closed
by documentation + gate changes above, with SDK source verification for each corrected claim).
