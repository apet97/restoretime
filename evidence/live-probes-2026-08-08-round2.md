# Live probes, round 2 — 2026-08-08 (DeepSeek Flash agents)

Two agents probed the sacrificial workspace `65b382b606de527a7ee2b60e` to close the ambiguous
areas left after the blueprint's adversarial review. Probe A: direct API behavior (prefix `DSEA_`).
Probe B: webhook captures via a fresh tunnel + receiver (prefix `DSEB_`). All entities, webhooks,
processes, and settings were reverted/cleaned and verified. Sanitized captures:
`/tmp/restoretime-probe-webhook/` (5 payloads).

## New facts (folded into docs/01 as R9/R10/R12/R15/R18–R21, W13/W15)

| # | Fact | Confidence |
|---|---|---|
| A1 | `listForUser` item = 15 fields: id, description, tagIds, userId, billable, taskId, projectId, workspaceId, timeInterval, customFieldValues, type, kioskId, hourlyRate, costRate, isLocked. **No created-at field.** `Last-Page` header present | PROVED |
| A2 | Windowed (`start`/`end`) listForUser is unreliable for fresh entries: absent >45 s; fixed result set; out-of-window items returned. No-filter and `description`-filtered lists reflect creates immediately (0 s) | PROVED |
| A3 | Running entry appears in the unfiltered list with `end:null`, `duration:null`. Stop-timer route is the bare PATCH `/user/{uid}/time-entries` `{end}` (PUT → 400 code 3002, bulk shape) | PROVED |
| A4 | Archived tag on create → 400, body code 501 "You can not create entities for archived tag" | PROVED |
| A5 | With `onlyAdminsCanChangeBillableStatus:true` + `defaultBillableProjects:true`: regular user's `billable:true` stored true; `billable:false` **silently stored as true** | PROVED |
| A6 | Dropdown CF value outside `allowedValues` → 201, stored verbatim. No server-side option validation | PROVED |
| A7 | Required-CF probe blocked by plan limit: creating a 6th visible CF → 400 code 4033 ("limit of 5 visible custom fields") | NOT_TESTABLE (behavior); PROVED (limit code) |
| A8 | Approval: user-scoped submit (`POST /approval-requests/users/{uid}` `{period, periodStart}`) → 201 PENDING; PATCH `{state:APPROVED}` → 200. **DELETE of an approved entry → 403 code 4005 "Can't edit approved time entry."** Withdraw → delete succeeds (204). Entry DTOs expose NO approval fields. Note: the plain `POST /approval-requests` path errors (code 501 "Approval period has changed…") | PROVED |
| A9/B2 | `PATCH /time-entries/invoiced` → 200, but invoice state is invisible on the entry read model (`isInvoiced:null`, no invoice keys). Invoiced entries delete normally (204); the deletion webhook fires and carries no invoice field | PROVED |
| A10 | Settings are immutable via API: PATCH/PUT `/workspaces/{ws}` → 405 code 3000 (flat and nested). Force-timer/lock toggling is UI-only | PROVED |
| B1 | Approved-entry deletion webhook: structurally unreachable (4005). Approval keys are present but `null` in all captures | NOT_TESTABLE (populated values) — and unnecessary |
| B3 | Cross-user deletion re-proof: admin deletes PM USER's entry → webhook `userId`/`user` = PM USER, no actor field | PROVED (upgrades W13 cross-user to PROVED_2X) |

## Blueprint changes forced by this round

1. **Reconcile read changed** (largest impact): the AMBIGUOUS protocol no longer uses the
   windowed list query. Baseline and delta both use the description-filtered list (unfiltered
   fallback). See docs/07 §8 and ADR-007 revision note.
2. Approval wording: no `UNSUBMITTED` field exists on entry DTOs; UI says "not part of any
   approval request". Approved entries can't be deleted, so approval loss is structurally
   impossible.
3. Archived tags: warning → ACTION_REQUIRED (they reject creation).
4. Billable: silent override is proved; P-BILL + post-create diff are the honesty mechanism.
5. CF dropdown options: not server-validated; P-CF-OPT gains keep-with-warning.
6. W13 cross-user owner semantics upgraded to PROVED_2X.
7. Live suite: LV-06 merged into LV-05; LV-09 re-pinned to the description-filtered read;
   settings-toggle probes removed (impossible via API, R20).

## Contradiction notes adjudicated

- B's "not flat" remark: terminology only. The blueprint's "flat" meant "unwrapped top-level entry
  object"; nested embedded entities were always documented. W1 wording clarified to "unwrapped".
- B's stray `listForUser` 400/501 "hexString" observation: not reproduced by probe A (which used
  the same route successfully with filters). Recorded as INCONSISTENT; no design impact.
