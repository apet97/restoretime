# 01 — Evidence baseline

Every implementation-critical fact, its evidence, confidence, and consequence. Confidence classes:
`PROVED_3X` (three independent agents), `PROVED_2X`, `PROVED_ONCE`, `INCONSISTENT`, `NOT_TESTABLE`,
`UNKNOWN`. Live addendum facts (L-series, `evidence/webhook-validation.md` §3) count as independent
controlled reproductions by the architect.

Sources: webhook campaign (`WH`), recreation campaign (`RC`), live addendum (`LIVE`), SDK source
(`SDK`).

## W-series — `TIME_ENTRY_DELETED` webhook

### W1 — Payload is flat and self-contained

- FACT: The body is a flat time-entry object, not wrapped in `{timeEntry:{...}}`. It is a superset
  of the pre-delete GET response for every stored field.
- EVIDENCE: WH payload-contract.md, all three agent reports, sanitized payloads S1–S14.
- CONFIDENCE: PROVED_3X.
- CONSEQUENCE: No snapshot store. No `/entities/*` feeds. Normalize the body directly at the
  boundary.

### W2 — Referenced entities are embedded with names and IDs

- FACT: `project`, `task`, `user`, `tags[]` are embedded objects with names, IDs, and extra data
  (project client/rates/archived; task status; user status/rates; tag archived flags).
- EVIDENCE: WH payload-contract.md, field-coverage-matrix.md.
- CONFIDENCE: PROVED_3X.
- CONSEQUENCE: The list UI shows names without any lookup. Normalization reads `task.id` and
  `tags[].id`; top-level `taskId`/`tagIds` do not exist in the payload.

### W3 — Description is byte-for-byte; literal `<`/`>` rejected at create

- FACT: Empty, ASCII, emoji, Cyrillic, newlines, tabs, and HTML-entity text round-trip exactly.
  Literal `<`/`>` are rejected by the create API (message "Don't use < and > characters").
- EVIDENCE: WH S4 (3X); RC edge-case-matrix. Status code reported as 501 (WH) and 400 (RC).
- CONFIDENCE: PROVED_3X (behavior); INCONSISTENT (status code 400 vs 501).
- CONSEQUENCE: Never parse error message text to classify; accept both codes. Descriptions from the
  webhook are always create-safe because they were stored (the API rejected `<`/`>` at the original
  create). Render descriptions escaped; they can contain entity text that looks like HTML.

### W4 — `billable` is preserved distinctly

- EVIDENCE: WH S7/S12. CONFIDENCE: PROVED_3X.
- CONSEQUENCE: Recreation sends the source `billable` value. See R16 for the workspace permission
  that can override it.

### W5 — Interval is exact; timezone data is webhook-only

- FACT: `timeInterval.start`/`end` are UTC ISO-8601 at second precision; `duration` is ISO-8601;
  `timeZone`, `offsetStart`, `offsetEnd`, `zonedStart`, `zonedEnd` are present only in the webhook.
- EVIDENCE: WH S8 (PT38S, cross-midnight, PT48H). CONFIDENCE: PROVED_3X.
- CONSEQUENCE: Store and recreate UTC instants. Use `timeZone`/`zoned*` for display only. Never
  trust source `duration`; Clockify recomputes it (R-series).

### W6 — Top-level `hourlyRate`/`costRate` are always null

- FACT: Rate inputs exist nested (`project.hourlyRate`, `user.hourlyRate`, `user.costRate`,
  amount only, no currency). The server-computed per-entry rate is not carried.
- EVIDENCE: WH S10. CONFIDENCE: PROVED_3X.
- CONSEQUENCE: Never show "original rate" as a recoverable value. The recreated entry gets current
  rates. This is a standard system difference, always listed in the UI.

### W7 — Custom-field items omit `type`

- FACT: `customFieldValues[]` items are `{customFieldId, timeEntryId, value, name}`; GET adds `type`.
- EVIDENCE: WH S6. CONFIDENCE: PROVED_3X (shape); PROVED_ONCE (user-set value fidelity, DSWH2).
- CONSEQUENCE: CF type comes from the workspace custom-field lookup at preflight, not the payload.

### W8 — Update→delete carries the final state

- FACT: After create v1 → update v2 → delete, the payload shows v2 values.
- EVIDENCE: WH S12. CONFIDENCE: PROVED_3X.
- CONSEQUENCE: The payload is the complete source record. No create-time snapshot adds anything.

### W9 — Rapid create→delete always fires

- EVIDENCE: WH S11 (0s ×3, 5s ×3, 6/6). CONFIDENCE: PROVED_3X.
- CONSEQUENCE: No minimum-lifetime handling in ingestion.

### W10 — Delivery is at-least-once; `idempotency-key` changes per attempt

- FACT: Retries after non-2xx carry a byte-identical body with a new `idempotency-key`. Genuine
  duplicates under 200-mode were observed. Retry timing is non-deterministic (~14–70 s). A retry
  can replay a batch of events together.
- EVIDENCE: WH S14, disagreements §4. CONFIDENCE: PROVED_3X.
- CONSEQUENCE: Dedup on payload `id` + event type only. Persist in the same transaction as the
  dedup decision, before the 2xx ack. Any non-2xx invites redelivery.

### W11 — Signature scheme differs by registration mode

- FACT: API-key-registered webhooks send `clockify-signature` = plain webhook `authToken`. Addon
  platform deliveries send an RS256 JWT plus a per-installation webhook token check.
- EVIDENCE: WH payload-contract (API-key mode, PROVED_3X); addon-ts-sdk
  `clockify-request-verifiers.ts` (addon mode, SDK).
- CONFIDENCE: PROVED_3X + SDK source.
- CONSEQUENCE: Use `withClockifyVerifiedWebhookRequest` from the addon SDK. Never parse the JWT or
  compare tokens by hand.

### W12 — Running entry deleted while running keeps `currentlyRunning:true`

- FACT: Genuinely running at deletion → `currentlyRunning:true`, `end:null`, `duration:null`,
  `offsetEnd:null`, `zonedEnd:null`. An auto-stopped entry arrives as a normal stopped entry.
- EVIDENCE: WH S9 + tie-break probe (DSWH2 3/3 exclusive; DSWH3 corroborates); disagreements §1.
- CONFIDENCE: PROVED_3X (after tie-break).
- CONSEQUENCE: Recreation can offer "recreate as running timer" (omit `end`) as an explicit user
  choice. Never silently start a timer.

### W13 — `userId` is the owner; there is no actor field

- FACT: `userId`/`user` identify the entry owner, never the deleter. Cross-user deletion carries
  the owner.
- EVIDENCE: WH S3; self-deletion PROVED_3X; cross-user PROVED_ONCE (DSWH2, admin deleted PM USER's
  entry).
- CONFIDENCE: PROVED_ONCE (cross-user), PROVED_3X (self).
- CONSEQUENCE: Authorization and recreation ownership key on `userId`. Do not show "deleted by".

### W14 — No timestamps on the payload

- FACT: No `createdAt`, `updatedAt`, or deletion time. The only deletion time reference is the
  receiver's own receipt time. Deliveries arrive sub-second to ~2 s after DELETE.
- EVIDENCE: WH payload-contract, S7 timing. CONFIDENCE: PROVED_3X.
- CONSEQUENCE: Store `detected_at` = server receipt time and label it honestly in the UI
  ("Detected", not "Deleted at").

### W15 — Approval/currency fields are always null in tested workspaces

- FACT: `approvalStatus`, `detailedApprovalStatus`, `projectCurrency` were `null` in every capture.
  No approval-enabled workspace was available.
- EVIDENCE: WH consensus gaps. CONFIDENCE: NOT_TESTABLE (populated values).
- CONSEQUENCE: Never claim approval or invoice restoration. Recreated entries are `UNSUBMITTED`
  (R12). If approval fields ever arrive populated, normalization keeps them for display only.

### W16 — Burst delivery has no ordering guarantee

- EVIDENCE: WH S13 (10/10 delivered, exactly once, two temporal clusters). CONFIDENCE: PROVED_3X.
- CONSEQUENCE: Ingestion must not depend on event order (e.g. delete-then-recreate-then-delete
  arrives as independent rows keyed by entry id).

## R-series — recreation API (`POST …/time-entries`)

### R1 — Create routes

- FACT: `POST /workspaces/{ws}/time-entries` → 201 for the authenticated key owner.
  `POST /workspaces/{ws}/user/{userId}/time-entries` → 201 for the target user (self and other).
  `userId` in the plain-route body is silently ignored. `POST /workspaces/{ws}/time-entries/{userId}`
  → 405 (wrong path).
- EVIDENCE: RC consensus + api-contract-matrix (plain route, ignored userId, 405); DSWH2 S3;
  LIVE L1/L2.
- CONFIDENCE: PROVED.
- CONSEQUENCE: The recreation engine uses the user-scoped route for every create (ADR-004). One
  code path; owner is explicit.

### R2 — Request body contract

- FACT: `{start, end?, description?, billable?, projectId?, taskId?, tagIds?}`. `end` omitted →
  running entry. `end` without `start` → 400 "Can't create time entry with end time only." Unknown
  fields are silently ignored. Duplicate `tagIds` are accepted and echoed.
- EVIDENCE: RC consensus, edge-case-matrix. CONFIDENCE: PROVED.
- CONSEQUENCE: The engine builds exactly this shape. `customFieldValues` is never sent (R5).

### R3 — Dependency validation is server-side and atomic

- FACT: Dead project → 400 "Project doesn't belong to Workspace". Task from another project → 400
  "Task doesn't belong to Project". Dead tag → 400 "Tag doesn't belong to Workspace".
- EVIDENCE: RC consensus. CONFIDENCE: PROVED.
- CONSEQUENCE: Preflight resolves dependencies with current-state lookups; a create rejection maps
  to a specific user-facing blocker (docs/07, docs/11).

### R4 — Project requiredness is workspace-dependent

- FACT: With `forceProjects` on, a completed entry without `projectId` → 501. A running entry
  (no `end`) bypasses the rule (201, `projectId:null`). An empty body creates a running entry.
- EVIDENCE: RC consensus + agent-7 (workspace settings); LIVE L7.
- CONFIDENCE: PROVED.
- CONSEQUENCE: Preflight reads workspace settings. If `forceProjects` is on and the source had no
  project, recreation as a completed entry is blocked; the user must pick a project or recreate as
  running.

### R5 — Custom-field values are not writable; current defaults auto-attach

- FACT: `customFieldValues` in create/update bodies is silently ignored on both create routes and
  on full-body PUT. No per-entry CF endpoint exists. A new entry auto-attaches the current active
  (VISIBLE+INVISIBLE) workspace custom fields with current defaults.
- EVIDENCE: LIVE L3–L6; DSWH1 §5; DSWH3 S6; agent-7 G15; operator statement 2026-08-08.
- CONFIDENCE: PROVED (negative), PROVED (auto-attach).
- CONSEQUENCE: Never send `customFieldValues` on recreate. Preflight compares source values vs
  current defaults and warns (fidelity rule F-CF). Post-create verification excludes CF from
  pass/fail.

### R6 — Archived projects accept creation

- FACT: Create with an archived project → 201. The 501 "project required … or archived" message
  text does not describe this case.
- EVIDENCE: RC consensus (PROVED); LIVE L7 (message text).
- CONFIDENCE: PROVED.
- CONSEQUENCE: Preflight treats archived project as allowed-with-warning, not blocked. Never
  classify errors by message text.

### R7 — No idempotency, no dedup, no overlap detection

- FACT: Identical sequential and concurrent creates all succeed with distinct IDs. No idempotency
  key exists. Overlapping intervals are permitted.
- EVIDENCE: RC consensus (2+2 creates), agent-7 G20/G30/G31.
- CONFIDENCE: PROVED.
- CONSEQUENCE: Duplicate prevention is application-side (database invariants). A blind retry after
  an ambiguous create will duplicate; the mutation protocol (docs/07) forbids it.

### R8 — Description validation

- FACT: `<`/`>` rejected (see W3). Unicode, emoji, newlines accepted. Future dates, DST boundaries,
  1 s–25 h durations accepted.
- EVIDENCE: RC G16–G18. CONFIDENCE: PROVED.
- CONSEQUENCE: Source descriptions are always create-safe (they were stored once). No client-side
  description rewriting, ever (no-silent-changes invariant).

### R9 — Recreated entry system state

- FACT: A recreated entry has a new ID, new audit timestamps, `approvalStatus:UNSUBMITTED`, no
  invoice linkage, and current rates. `kioskId` is not settable.
- EVIDENCE: RC recreation-fidelity-matrix, approval probes (create → UNSUBMITTED).
- CONFIDENCE: PROVED (create-response state); NOT_TESTABLE (invoice linkage behavior).
- CONSEQUENCE: These are the standard system differences shown on every recreation (docs/10).
  Fidelity FULL ignores them.

### R10 — Ambiguous create outcome is possible

- FACT: A POST can commit while the client never learns the result (timeout, reset, 5xx after
  commit). No idempotency key exists to retry safely. Reconciliation read:
  `GET /workspaces/{ws}/user/{userId}/time-entries?start&end`.
- EVIDENCE: RC consensus (mechanism PROVED, scenario inferred); agent-7 G32/G33.
- CONFIDENCE: PROVED (mechanism).
- CONSEQUENCE: The AMBIGUOUS protocol (docs/07 §8): baseline-delta matching, bounded re-poll,
  never auto-retry, user resolves collisions. List-response field coverage (taskId/tagIds/billable
  presence) is UNVERIFIED — the release live suite pins it (docs/13).

### R11 — Auth schemes

- FACT: `X-Api-Key` and `X-Addon-Token` are distinct. Sending both → 401 code 1000. Bad API key →
  401 code 4003. Bad addon token → 401 code 4017. Bearer is unsupported.
- EVIDENCE: RC addon-token-matrix. CONFIDENCE: PROVED (failure paths); NOT_TESTABLE (addon-token
  success path).
- CONSEQUENCE: The REST client sends exactly one auth mode. For this addon: the installation
  `authToken` as `X-Addon-Token`. The release live suite verifies success paths.

### R12 — Workspace settings readable

- FACT: Settings expose `forceProjects`, `forceTasks`, `forceTags`, `forceDescription`,
  `onlyAdminsCanChangeBillableStatus`, `timeApprovalEnabled`, `invoicingEnabled`,
  `lockTimeEntries` (null in the test workspace), `trackTimeDownToSecond`.
- EVIDENCE: agent-7 §3 (GET workspace/settings).
- CONFIDENCE: PROVED_ONCE.
- CONSEQUENCE: Preflight reads these once per preflight. `onlyAdminsCanChangeBillableStatus:true`
  means a regular user's `billable:true` recreate can be forced to `false` by the server — the
  post-create diff catches and reports this drift.

### R13 — Deleted/created/updated feeds are unusable for this product

- FACT: `/entities/deleted` documents are truncated (no interval/project/task/tags/user/CFs), the
  feed excludes entries created inside the query window, and silently drops records.
  `/entities/created` prunes deleted entries. `/entities/updated` returned no records.
- EVIDENCE: RC consensus, disagreements D1–D3. CONFIDENCE: PROVED.
- CONSEQUENCE: ADR-002 bans all three feeds. The webhook alone is the source.

### R14 — Update semantics

- FACT: `PUT /time-entries/{id}` is a full replace. The recreation engine never updates entries.
- EVIDENCE: agent-7. CONFIDENCE: PROVED.
- CONSEQUENCE: None for recreation. Listed so implementers do not invent an update path.

### R15 — Error codes observed

- FACT: 400 for dead references, `start>end`, `limit<1`, missing `type` (code 3001), end-only.
  401 codes 1000/4003/4017 for auth. 404 for fake workspace and unknown static routes. 405 for
  wrong method paths. 501 for domain validation (project required, `<`/`>`). 500+ is the ambiguity
  trigger class.
- EVIDENCE: RC api-contract-matrix, LIVE probes.
- CONFIDENCE: PROVED; INCONSISTENT (400 vs 501 for some domain errors across reports).
- CONSEQUENCE: Failure mapping keys on status class + parsed body `code`/`message` where present,
  never on message text alone. 4xx → FAILED (not committed; validation is atomic per R3). 5xx or
  transport failure → AMBIGUOUS.

## S-series — SDK facts

See `docs/04-sdk-integration-map.md` for the full map. Load-bearing facts:

### S1 — Addon platform verification is SDK-owned

- FACT: RS256 JWT verification, per-installation webhook token compare, component `?auth_token`
  verification (requires `exp`), lifecycle token verification, and constant-time compares are
  implemented and tested in `addon-ts-sdk`.
- CONSEQUENCE: The app never implements its own JWT/signature logic.

### S2 — Viewer identity and role come from the component JWT

- FACT: Verified component claims include `user` (viewer id), `workspaceId`, `workspaceRole`
  (`owner`/`admin`/member), `language`, `theme`, backend URLs. `isClockifyAdminRole` maps
  owner/admin → admin.
- CONSEQUENCE: The authorization boundary (docs/09) is: verified claims → policy predicate. Role
  is never accepted from request bodies or the client.

### S3 — Installation token never expires; per-installation storage is consumer-built

- FACT: The `INSTALLED` payload carries `authToken` (no expiry) and per-webhook tokens. The SDK
  ships the `ClockifyInstallationStore` interface, an AES-256-GCM encryption wrapper, and an
  in-memory implementation only.
- CONSEQUENCE: The app implements one durable store over its database and wraps it with the SDK
  encryption codec.

### S4 — Clockify REST SDK behavior

- FACT: Recorded in `docs/04-sdk-integration-map.md` (routes, models, create-for-user support,
  error model) after source inspection.
- CONSEQUENCE: Any route/serialization defect found there is a blocking dependency fixed upstream,
  not worked around in the app (AGENTS.md).

## Evidence hierarchy (standing rule)

1. Current controlled live behavior reproduced independently.
2. Tie-breaker live evidence.
3. SDK source + tests.
4. Corrected OpenAPI.
5. Official OpenAPI.
6. Documentation.
7. Assumption (never architecture-load-bearing).
