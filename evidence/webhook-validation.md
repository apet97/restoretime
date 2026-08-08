# Webhook validation — sufficiency review

## 1. Verdict

**`WEBHOOK_ONLY_SUFFICIENT`** — confirmed independently by this planning pass.

The `TIME_ENTRY_DELETED` webhook body is a flat time-entry object. It is a superset of the
pre-delete `GET /workspaces/{ws}/time-entries/{id}` response for every stored field, and it embeds
`project`, `task`, `user`, and `tags[]` with names and IDs. Three independent agents captured real
deliveries across 14 scenarios and agree (`time-entry-deleted-webhook/consensus-report.md`).

### Review method (independence check)

This pass did not trust the printed verdict. The architect read all three agent reports, the
disagreement log, the payload contract, the field-coverage matrix, and the scenario matrix, then
checked the verdict against the primary observations:

- The `WEBHOOK_PLUS_SNAPSHOT_REQUIRED` interim position (DSWH1) rested on one running-entry
  observation. The tie-break probe (DSWH2, 3/3 exclusive, corroborated by DSWH3) proved the cause
  was a shared-user single-timer auto-stop artifact. The snapshot argument has no remaining basis.
- Every field required to display, authorize, preflight, and recreate a deleted entry is present in
  the payload (see `docs/01-evidence-baseline.md`, W-series). The only regressions vs GET are
  top-level `hourlyRate`/`costRate` (always `null`; inputs present under `project`/`user`) and
  per-item custom-field `type` (resolved by a workspace custom-field lookup at preflight).
- At-least-once delivery is handled by natural-key idempotent persistence, not by extra feeds.

### Consequences

- No pre-delete snapshot tracking. The payload carries the final state (PROVED_3X, update→delete
  scenario S12).
- No `/entities/deleted` polling. The feed is truncated, window-exclusionary, and lossy (recreation
  campaign, PROVED). It provides nothing the webhook lacks. See ADR-002.
- No `/entities/created` or `/entities/updated` tracking.
- Current-state lookups happen only at preflight time, to validate that dependencies still exist
  and are assignable. They are not a substitute source of the deleted entry's data.

## 2. Transport contract (addon mode)

The campaign captured API-key-registered webhooks: `clockify-signature` carries the plain webhook
`authToken`. An installed marketplace addon receives webhooks through the addon platform instead:
the header carries an RS256 JWT, and verification also compares the per-installation webhook token
delivered in the `INSTALLED` lifecycle payload. `addon-ts-sdk` implements this
(`verifyClockifyWebhookRequest`, `withClockifyVerifiedWebhookRequest`; see
`docs/04-sdk-integration-map.md`). The implementation must use the SDK verifier and must not parse
the JWT itself.

Delivery semantics the endpoint must satisfy:

| Property | Behavior | Evidence |
|---|---|---|
| Delivery | At-least-once; retries after non-2xx with byte-identical body | PROVED_3X (S14) |
| `idempotency-key` header | New value per attempt. Never use it for dedup | PROVED_3X |
| Dedup key | Payload `id` + `clockify-webhook-event-type` | PROVED_3X |
| Retry timing | Non-deterministic (~14–70 s observed); replay can batch events | PROVED_3X |
| Ordering | Not guaranteed across a burst | PROVED_3X (S13) |
| Latency | Sub-second to ~2 s after DELETE | PROVED_3X |

## 3. Live addendum (2026-08-08, architect probes)

Targeted probes with the operator API key on the sacrificial workspace `65b382b606de527a7ee2b60e`.
All probe entries were deleted after measurement. These close gaps the campaigns left open.

| # | Probe | Result | Confidence |
|---|---|---|---|
| L1 | `POST /workspaces/{ws}/user/{userId}/time-entries` for another user (PM USER) | 201, response `userId` = target user | PROVED (also DSWH2) |
| L2 | Same route for self | 201 | PROVED |
| L3 | `customFieldValues` in create body, plain route and user-scoped route | Values silently ignored (stored `null`) | PROVED (also DSWH1, DSWH3, agent-7) |
| L4 | `customFieldValues` in full-body `PUT /time-entries/{id}`, two item shapes | Silently ignored | PROVED |
| L5 | Candidate per-entry CF endpoints (6 paths) | 404 (`/time-entries/custom-field-values` 405 per DSWH3) | PROVED |
| L6 | Create with no `customFields` in body | Current workspace custom fields auto-attached with current defaults (e.g. `test123="tqewq"`) | PROVED (matches operator statement: active VISIBLE+INVISIBLE fields attach automatically) |
| L7 | Completed entry without `projectId` in this workspace | 501 "Project is either required field or given project is archived…" | PROVED (message text is generic; archived projects still accept creates per recreation campaign — never classify by message text) |
| E1 | Create (route B) with `customFields: [{customFieldId, sourceType:"WORKSPACE", value}]` | Values stored exactly; numeric string `"777.5"` returned as number `777.5` | PROVED |
| E2 | Create (route A, plain) with the same key | Values stored exactly | PROVED |
| E3 | Full-body PUT with `customFields` | Edit applied; omitted fields reset to default (full-replace semantics) | PROVED (product never updates entries) |

### Custom-field conclusion (corrected 2026-08-08, second revision)

The first revision concluded per-entry CF writes were impossible. That was wrong in cause: every
negative probe (L3/L4 here, DSWH1, DSWH3, agent-7) sent the **response-shaped** key
`customFieldValues`, which the API silently ignores. With the correct request key `customFields`
(items `{customFieldId, sourceType:"WORKSPACE", value}`), values are stored at create on both
routes (E1/E2) and editable via full-body PUT (E3). The operator confirms: values can be input
when they differ from the default; untouched fields auto-attach current defaults.

Therefore:

- The recreation request includes `customFields` for source values that differ from current
  defaults (and for user-entered values), never the `customFieldValues` key.
- A removed field or invalid dropdown option is an explicit preflight resolution (P-CF rules in
  docs/07), not silent loss.
- Post-create verification compares CF values (numeric-tolerant).

### Force-timer and lock evidence (operator guide, live-tested 2026-08-07/08)

`~/Downloads/clockify-force-timer-guide.md` documents the live matrix on the same sacrificial
workspace: force timer (`timeTrackingMode:"STOPWATCH_ONLY"`) rejects entries with `end` via 403
code `4030` — everyone on the plain route, regular users only on the user-scoped route
(owner/admins bypass). Locks reject via 403 code `1003` for regular users; owner/admins are exempt
on both routes. This grounds docs/01 R15/R16 and preflight rules P-TIMER/P-LOCK.

## 4. What remains unverifiable here

| Unknown | Why | Handling |
|---|---|---|
| Addon-token success path on Clockify REST calls | No installed addon existed in any test environment; operator states API key and addon token act the same toward REST | LV-04 confirms on the real addon path before submission (docs/13) |
| Approval-enabled deletion payload fields | No approval workspace available | Never claim approval restoration; post-create state is `UNSUBMITTED` (PROVED) |
| Invoiced-entry deletion | Not producible | Warn category; see docs/11 |
| Locked-period date semantics (which ranges are locked) | Lock configuration not creatable via API; the rejection (403/1003) and admin exemption are PROVED, the range computation is not | P-LOCK-REG warns without date math; rejection mapping is precise (R15/R16) |
| Archived-tag create behavior | Not probed | P-TAG-ARCH warning; LV-06 closes it |
