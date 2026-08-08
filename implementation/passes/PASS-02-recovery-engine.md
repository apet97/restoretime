# PASS-02 — Recovery engine

## Mission

Build the complete backend product: webhook ingestion, normalization, persistence, authorization,
preflight engine, immutable plans, the claim/mutation protocol, post-create verification, the
ambiguity protocol, and lineage. After this pass, every `/api/*` endpoint works against a mocked
Clockify transport and the full test matrix (unit + contract + integration) is green. No real UI
beyond API JSON (PASS-03 renders it).

## Repository

`~/Downloads/working/addons-me/restoretime` after PASS-01 merge. Read-only SDK sources remain
untouched.

## Authoritative reading order

1. `IMPLEMENTER.md`
2. `docs/01-evidence-baseline.md` — the fact inventory (W/R/S series)
3. `docs/06-recovery-domain.md` — models and the lifecycle state machine
4. `docs/07-recreation-preflight.md` — the algorithm; implement it rule-for-rule
5. `docs/08-data-model.md` — all four tables
6. `docs/09-permissions.md`, `docs/03-api-and-webhook-contract.md`
7. `docs/13-testing.md` — the UT/CT/IT matrix you must satisfy
8. `evidence/webhook-validation.md` — including the custom-field conclusion

## Current expected state

PASS-01 merged: platform boundaries, installations store, `requireViewer`, component shell,
`/api/ping` placeholder, CI. `src/api/routes.ts` is mostly empty.

## Scope

### Ingestion

- `src/ingest/deleted-entry.ts`: hand-rolled guard + normalization to `DeletedTimeEntry`
  (docs/06 exact shape). Reject malformed bodies (400). No third-party validation library.
- `src/ingest/webhook.ts`: replace the PASS-01 stub. Verify via
  `withClockifyVerifiedWebhookRequest` with `getExpectedWebhookAuthToken` reading the stored
  per-installation webhook tokens (keyed by webhook path from the INSTALLED payload; v1 has exactly
  one webhook). Then: guard → normalize →
  `INSERT OR IGNORE` → lineage link (`parent_recoverable_id` when the deleted id matches an
  existing `new_entry_id`) → 204. Both writes are one transaction (docs/05 invariant 1).

### Store

- Migrations 0002: `recoverable_entries`, `recreation_plans`, `recreation_attempts` per docs/08,
  including `UNIQUE(workspace_id, source_entry_id)`, the partial unique index on
  `(workspace_id, new_entry_id)`, and the ACTIVE-plan partial unique index.
- `src/store/entries.ts|plans.ts|attempts.ts`: prepared-statement query modules. Include the
  atomic claim (docs/07 §6 verbatim SQL), fenced transition writes (`AND claim_token=?`), and the
  lazy re-claim on expired lease.

### Domain (pure modules, no I/O)

- `src/domain/entry.ts`, `policy.ts` (docs/09 two rules), `preflight.ts` (docs/07 §2–§5:
  decision rules P-* exactly as tabled), `fidelity.ts` (§10), `plan.ts` (hash, staleness compare).
- `src/clockify/client.ts`: build `createClockifyClient({addonToken, baseUrl})` from the
  installation (`apiUrl` via `resolveClockifyApiBaseUrl`); injected `fetch` for tests.
- `src/clockify/preflight-data.ts`: the six-lookup fetch set (docs/07 §2).
- `src/clockify/recreate.ts`: baseline snapshot → `createForUser` → branch per docs/07 §8;
  verification diff per §9; reconcile (baseline-delta + fingerprint) per §8.

### API (all behind `requireViewer`; workspace from claims only)

- `GET /api/entries` — role-scoped list + admin filters (user, project, date range, status,
  search) + dismissed toggle. Preflight summary is computed on demand per listed row (cheap:
  lookups are already needed for detail; batch the six lookups per workspace, not per row — one
  fetch set per request, share across rows).
- `GET /api/entries/{id}` — source, current lifecycle, latest plan, attempts, lineage links.
- `POST /api/entries/{id}/preflight` — body `{choices?}`; returns the plan (or blockers /
  ACTION_REQUIRED items).
- `POST /api/entries/{id}/recreate` — body `{planId}`; runs §7 revalidation then §8.
- `POST /api/entries/{id}/reconcile` — manual "Check now" (30 s throttle).
- `POST /api/entries/{id}/mark-not-created` — only from AMBIGUOUS after the bounded window
  (≥3 checks / ~10 min enforced server-side).
- `POST /api/entries/{id}/resolve-ambiguous` — body `{newEntryId}`; adopts after verifying the
  candidate matches the fingerprint; unique-index conflict → 409.
- `POST /api/entries/{id}/dismiss` / `undismiss`.
- `GET /api/options?kind=projects|tasks&projectId=…|tags` — picker data.
- Remove `/api/ping` (noted in PASS-01).
- Lazy reconcile: detail GET on an AMBIGUOUS row triggers one reconcile pass when the last check
  is older than 30 s (ADR-010).

### Fixtures

Copy the webhook campaign sanitized payloads into `tests/fixtures/webhook/` from
`~/Downloads/api-testing-restoration/time-entry-deleted-webhook/sanitized-payloads/` (DSWH1 s1, s2,
s9; DSWH2 S2 + one tie-break running payload; DSWH3 S2). Verify each file contains no credential
material (grep for key patterns) before committing.

## Explicit out of scope

UI rendering, bulk execution (PASS-03 wires the loop; the per-entry engine you build here is what
it calls), live API calls, metrics polish, dismiss-undismiss UI.

## Safety invariants

- Docs/05 invariants 1–6 hold; the claim SQL is exactly docs/07 §6.
- POST is never retried (SDK default; do not enable mutation retries).
- 4xx → FAILED with mapped reason; 5xx/timeout/reset → AMBIGUOUS. Never parse message text to
  classify (R6/R15).
- CF values go out only as `customFields` items `{customFieldId, sourceType:"WORKSPACE", value}`
  per P-CF (R5); the `customFieldValues` key is never sent. Only `REGULAR` sources reach the
  mutation path (P-TYPE). No update/delete of Clockify entries anywhere.
- `/api/*` derives identity from claims only (docs/09).

## Tests

The full docs/13 matrix UT/CT/IT. Mock transport = stub `fetch` with recorded response shapes.
Integration uses a real SQLite temp file. Concurrency proof (IT-03): two parallel recreate calls
against the same row; assert exactly one 201-path and one current-state response.

## Commands/gates

`npm run typecheck && npm run lint && npm run test && npm run build` green. Test count covers every
UT/CT/IT ID in docs/13.

## Git requirements

Branch `pass-02-engine`; commits: fixtures+normalization / store+claim / preflight / mutation /
api. PR, CI green, squash-merge.

## Completion criteria

Docs/13 UT/CT/IT rows all exist and pass; a scripted walkthrough (vitest integration scenario)
drives webhook → list → preflight → confirm → RECREATED and the AMBIGUOUS flows against the mock
transport.

## Final report format

`implementation/reports/PASS-02.md`: fixture provenance + sanitization check; rule coverage table
(P-* → test IDs); gate outputs; deviations; limitations.
