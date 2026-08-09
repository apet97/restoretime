# 01 — Evidence baseline

Every implementation-critical fact, its evidence, confidence, and consequence. Confidence classes:
`PROVED_3X` (three independent agents), `PROVED_2X`, `PROVED_ONCE`, `INCONSISTENT`, `NOT_TESTABLE`,
`UNKNOWN`. Live addendum facts (L-series, `evidence/webhook-validation.md` §3) count as independent
controlled reproductions by the architect.

Sources: webhook campaign (`WH`), recreation campaign (`RC`), live addendum (`LIVE`), SDK source
(`SDK`).

## W-series — `TIME_ENTRY_DELETED` webhook

### W1 — Payload is unwrapped and self-contained

- FACT: The body's top level is the time-entry object itself — not wrapped in `{timeEntry:{...}}`.
  Referenced entities are embedded as nested objects (`project`, `task`, `user`, `tags[]`). It is
  a superset of the pre-delete GET response for every stored field.
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
- EVIDENCE: WH S4 (3X); RC edge-case-matrix; operator guide error table. The status-code
  discrepancy (reports said 400 and 501) is reconciled: HTTP 400 with body `code: 501` (R15).
- CONFIDENCE: PROVED_3X.
- CONSEQUENCE: Classify by parsed body code, never message text. Descriptions from the webhook are
  always create-safe because they were stored (the API rejected `<`/`>` at the original create).
  Render descriptions escaped; they can contain entity text that looks like HTML.

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
  `clockify-request-verifiers.ts` (addon mode, SDK). Addon-mode delivery proved live 2026-08-08
  (install capture): a real deletion fired `TIME_ENTRY_DELETED` to the declared webhook path; the
  SDK RS256 + per-installation token verification passed; the payload matched the contract (flat
  entry, embedded project, owner `userId`).
- CONFIDENCE: PROVED_3X (API-key mode) + PROVED (addon mode, developer environment 2026-08-08).
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
- EVIDENCE: WH S3; self-deletion PROVED_3X; cross-user PROVED twice independently (DSWH2: admin
  deleted PM USER's entry; round-2 probe B3 2026-08-08 re-proved it with a fresh capture).
- CONFIDENCE: PROVED_2X (cross-user), PROVED_3X (self).
- CONSEQUENCE: Authorization and recreation ownership key on `userId`. Do not show "deleted by".

### W14 — No timestamps on the payload

- FACT: No `createdAt`, `updatedAt`, or deletion time. The only deletion time reference is the
  receiver's own receipt time. Deliveries arrive sub-second to ~2 s after DELETE.
- EVIDENCE: WH payload-contract, S7 timing. CONFIDENCE: PROVED_3X.
- CONSEQUENCE: Store `detected_at` = server receipt time and label it honestly in the UI
  ("Detected", not "Deleted at").

### W15 — Approval/currency fields are always null; approved entries cannot be deleted

- FACT: `approvalStatus`, `detailedApprovalStatus`, `projectCurrency` were `null` in every capture
  (campaign + 5 round-2 captures). A genuinely approved entry could not be produced for a payload
  test — and structurally never will produce one: deleting an approved entry is rejected (403 code
  `4005`) until the approval is withdrawn (R9). Round-2 note: one approvals API path errors with
  code `501` ("Approval period has changed…"), while the user-scoped submit path works.
- EVIDENCE: WH consensus gaps; round-2 probes A8/B1/B2.
- CONFIDENCE: PROVED (null in all captures); PROVED (4005 deletion block); NOT_TESTABLE (populated
  approval payload — structurally unreachable for deletions).
- CONSEQUENCE: Never claim approval restoration. If approval fields ever arrive populated,
  normalization keeps them for display only.

### W16 — Burst delivery has no ordering guarantee

- EVIDENCE: WH S13 (10/10 delivered, exactly once, two temporal clusters). CONFIDENCE: PROVED_3X.
- CONSEQUENCE: Ingestion must not depend on event order (e.g. delete-then-recreate-then-delete
  arrives as independent rows keyed by entry id).

### W17 — INSTALLED webhook paths can carry a double leading slash

- FACT: The INSTALLED lifecycle payload can carry the webhook path as `//webhooks/time-entry-deleted` (Clockify joins `baseUrl` + "/" + the manifest path).
- EVIDENCE: install-capture 2026-08-08 (captured payload; the token lookup must normalize paths before comparing).
- CONFIDENCE: PROVED (one capture).
- CONSEQUENCE: Webhook-token storage and lookup key on a normalized path (collapse repeated slashes, reduce absolute URLs to their pathname). Docs/03 §1, docs/04, PASS-02.

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

### R5 — Custom-field values: writable at create with the `customFields` key

- FACT: Per-entry CF values are settable at create time via
  `customFields: [{customFieldId, sourceType:"WORKSPACE", value}]` — verified live on BOTH create
  routes (E1 route B, E2 route A: values stored exactly; numeric strings normalize to numbers).
  Full-body PUT with the same key edits values (E3; omitted fields reset to default — the product
  never updates entries). The response-shaped key `customFieldValues` is silently ignored on write
  (the earlier negative results L3/L4, DSWH1/DSWH3, agent-7 all used that key). Fields not
  mentioned in the request auto-attach with current workspace defaults. Operator rule: only values
  that differ from the default can be input — so recreation sends only differing values; equal
  values attach automatically.
- EVIDENCE: LIVE E1–E3 (2026-08-08); operator guide (force-timer guide §5/§7, live-tested);
  operator statement 2026-08-08; negatives: L3/L4, DSWH1 §5, DSWH3 S6, agent-7 G15.
- CONFIDENCE: PROVED.
- CONSEQUENCE: Recreation includes `customFields` for source values that differ from current
  defaults (docs/07 P-CF). Never send the `customFieldValues` key. Post-create verification
  compares CF values (§9 diff applies). A removed field or invalid dropdown option is a preflight
  resolution case, not silent loss.

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

### R9 — Recreated entry system state (approval, invoice, identity)

- FACT: A recreated entry has a new ID, new audit timestamps, and current rates. Entry DTOs (GET
  and list) expose NO approval fields and NO invoice fields at all (15-field item, verified). An
  APPROVED entry cannot be deleted: DELETE → 403 code `4005` "Can't edit approved time entry."
  until the approval is withdrawn — so a deleted entry was never approved at deletion time.
  Invoiced entries CAN be deleted (204); their deletion webhook fires and carries no invoice
  marker; `markInvoiced` state is not visible on the entry read model at all.
- EVIDENCE: RC recreation-fidelity-matrix; live round-2 probes A8/A9/B2 (2026-08-08); operator
  directive: "if an entry was locked or invoiced or approved — just recreate it; you cannot add an
  invoiced or approved entry via add time entry."
- CONFIDENCE: PROVED.
- CONSEQUENCE: UI wording is exact: "The new entry is not part of any approval request and is not
  linked to any invoice." Do not quote `UNSUBMITTED` as a field value — no such field exists on
  entry DTOs. Approval can never be silently lost by deletion, because Clockify blocks deleting
  approved entries.

### R10 — Ambiguous create outcome; reconcile read reliability

- FACT: A POST can commit while the client never learns the result (timeout, reset, 5xx after
  commit). No idempotency key exists. Reconciliation read:
  `GET /workspaces/{ws}/user/{userId}/time-entries`. Round-2 probes (2026-08-08) proved: the
  `start`/`end`-windowed variant is UNRELIABLE for fresh entries (a new entry stayed absent >45 s;
  the windowed result set was fixed and even returned out-of-window items). The no-filter and
  `description`-filtered variants return fresh entries immediately (0 s). List items carry 15
  fields — `taskId`, `tagIds`, `billable`, `customFieldValues`, `hourlyRate`, `costRate` present;
  NO created-at field.
- EVIDENCE: RC consensus (mechanism); live round-2 probes A1/A2/A3.
- CONFIDENCE: PROVED.
- CONSEQUENCE: The AMBIGUOUS protocol (docs/07 §8) uses the **description-filtered** list
  (fallback: no-filter list, paginated) plus client-side fingerprint matching on
  start/end/billable/project/task/tags — never the windowed query. Baseline-delta (not a
  created-after filter) remains mandatory because no created-at exists. Running entries appear in
  the unfiltered list with `end:null`.

### R11 — Auth schemes

- FACT: `X-Api-Key` and `X-Addon-Token` are distinct. Sending both → 401 code 1000. Bad API key →
  401 code 4003. Bad addon token → 401 code 4017. Bearer is unsupported. Operator statement
  (2026-08-08): an addon token and an API key behave the same toward the REST API. Live proof
  2026-08-08 (install capture on the developer environment, workspace 69bda6b317a0c5babe34b4ff):
  with the captured addon token, `users.list` (10 users), `projects.list` (36 projects),
  `timeEntries.createForUser` for another user → 201 with the target `userId`, `timeEntries.get`,
  and `timeEntries.delete` all succeeded.
- EVIDENCE: RC addon-token-matrix; operator statement; evidence/install-capture-2026-08-08.md.
- CONFIDENCE: PROVED (developer environment, 2026-08-08); operator-stated equivalence additionally
  confirmed — production re-confirmation remains LV-04.
- CONSEQUENCE: The REST client sends exactly one auth mode: the installation `authToken` as
  `X-Addon-Token`. LV-04 re-confirms on production, as confirmation of the equivalence on the real
  addon path (admin recreating another user's entry).

### R12 — Workspace settings readable

- FACT: Settings expose `forceProjects`, `forceTasks`, `forceTags`, `forceDescription`,
  `onlyAdminsCanChangeBillableStatus`, `timeApprovalEnabled`, `invoicingEnabled`,
  `lockTimeEntries` (null in the test workspace), `trackTimeDownToSecond`, and `timeTrackingMode`
  (`"DEFAULT" | "STOPWATCH_ONLY"` — `STOPWATCH_ONLY` is the force-timer setting, R16).
  SDK note: the typed `WorkspaceSettingsDtoV1` carries `forceProjects`, `lockTimeEntries`,
  `automaticLock`, `onlyAdminsCanChangeBillableStatus`, and `timeTrackingMode`, but not
  `timeApprovalEnabled` or `invoicingEnabled` (live-observed only). Preflight reads settings
  through the SDK model and never depends on the two untyped fields; approval/invoice behavior is
  an always-shown system difference, not a settings branch.
- EVIDENCE: agent-7 §3 (GET workspace/settings); SDK type inspection 2026-08-08; operator guide.
- CONFIDENCE: PROVED_ONCE.
- CONSEQUENCE: Preflight reads these once per preflight. Silent billable override is PROVED, not
  hypothetical: with `onlyAdminsCanChangeBillableStatus:true` + `defaultBillableProjects:true`, a
  regular user's `billable:false` create was stored as `true` (and `billable:true` stored true) —
  round-2 probe A5. P-BILL warns and the post-create diff reports the actual stored value.

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

### R15 — Error codes (status + body code)

- FACT: Clockify errors carry an HTTP status AND a body `code`; classification keys on the code,
  never on message text. **The body `code` is a JSON number, and some 4xx bodies carry no `code`
  at all** (fresh-pass probes FP-1/FP-2, 2026-08-08: `400 {"message":…,"code":501}`,
  `401 {…,"code":4017}`, `404` with no `code` key). At the then-pinned `clockify-sdk-ts-115@2.0.0`
  the SDK helper `getErrorCode` returned only **string** body codes, so it returned `undefined` for
  every Clockify numeric code — the app reads the code itself and normalizes with `String()`
  (docs/03 §6). *(Superseded 2026-08-09: `@3.0.0` fixed `getErrorCode`; the app keeps its
  normalizer to pin its own classification, and the two now agree — docs/03 §6, docs/04.)*
  Verified mapping: 403 + code `4030` =
  force-timer rejection ("Manual time tracking disabled…"); 403 + code `1003` = locked-period
  rejection ("Can't edit locked time entry."); 400 + body code `501` = domain validation (project
  required, `<`/`>` — this reconciles earlier reports that said "400" and "501": both were right);
  401 codes 1000/4003/4017 (auth); 404 unknown workspace/route; 405 wrong method. 5xx and
  transport failures are the ambiguity trigger class.
- EVIDENCE: RC api-contract-matrix; LIVE probes; operator force-timer guide (live-tested
  2026-08-07/08).
- CONFIDENCE: PROVED. Note: body code `501` covers several project causes (required, archived —
  and archived projects actually accept creates, R6) → distinguish causes with preflight lookups,
  not codes.
- CONSEQUENCE: 4xx → FAILED with the code-mapped reason (docs/07 §8, UT-M01). 5xx/transport →
  AMBIGUOUS. Codes 4030 and 1003 map to specific user-facing explanations with the admin-bypass
  path (R16). A 4xx with no body code maps on status alone (UT-M01 code-absent case).

### R16 — Force-timer and locked-period enforcement, with admin bypass

- FACT: Force timer (workspace setting "Manual time tracking disabled"; settings field
  `timeTrackingMode: "STOPWATCH_ONLY"`) rejects entries that have an `end` with 403 code `4030`.
  On the plain route A the ban rejects everyone including admins; on the user-scoped route B,
  regular users are rejected but **owner/admins bypass**. Time locks reject entries in locked
  ranges with 403 code `1003` for regular users on both routes; **owner/admins are exempt on
  both**. On route A the ban check fires before the lock check.
- EVIDENCE: operator force-timer guide (live-tested matrix on the sacrificial workspace,
  2026-08-07/08); SDK `WorkspaceSettingsDtoV1.timeTrackingMode` type.
- CONFIDENCE: PROVED (operator live matrix); settings-field mapping SDK-verified.
- CONSEQUENCE: Preflight rules P-TIMER and P-LOCK (docs/07). The product uses route B exclusively
  (ADR-004), so: admins can always recreate (bypass); regular users hitting force-timer or a lock
  get a precise explanation and the "ask an admin" path.

### R17 — Only `REGULAR` entries are recreatable

- FACT: Every captured webhook entry had `type:"REGULAR"`. The create models accept
  `REGULAR`/`BREAK`; `TimeEntry` responses also include `TIMEOFF`/`HOLIDAY`/`OVERTIME`. Operator
  directive (2026-08-08): recreate only `REGULAR`; never breaks, time off, or holidays.
- EVIDENCE: WH payload contract; SDK models; operator directive.
- CONFIDENCE: PROVED (evidence scope) + directive (product rule).
- CONSEQUENCE: The source stores `type`; preflight rule P-TYPE blocks non-`REGULAR` sources with
  an explanation. No UI is built for other types.

### R18 — Archived tags reject creation

- FACT: Create with an archived tag → 400 with body code `501` "You can not create entities for
  archived tag". (Contrast: archived PROJECTS accept creates, R6.)
- EVIDENCE: live round-2 probe A4 (2026-08-08).
- CONFIDENCE: PROVED.
- CONSEQUENCE: P-TAG-ARCH is a resolution case (ACTION_REQUIRED: remove or replace), not a
  warning. Error mapping must not confuse its code `501` with project-required `501` — preflight
  lookups distinguish causes, codes never do (R15).

### R19 — Dropdown custom-field options are not server-validated

- FACT: Create with a value outside `allowedValues` for a DROPDOWN_SINGLE field → 201; the value
  is stored verbatim. There is no server-side option validation.
- EVIDENCE: live round-2 probe A6 (2026-08-08).
- CONFIDENCE: PROVED.
- CONSEQUENCE: P-CF-OPT offers keep-with-warning (value preserved verbatim but absent from current
  options), replace (current option), or drop (PARTIAL). Never assume a rejection.

### R20 — Workspace settings are immutable via the API

- FACT: PATCH/PUT `/workspaces/{ws}` (flat and nested) → 405 code `3000`. Force-timer and lock
  settings can only be changed in the Clockify UI.
- EVIDENCE: live round-2 probe A10 (2026-08-08); agent-7 G25.
- CONFIDENCE: PROVED.
- CONSEQUENCE: The live suite cannot toggle force-timer/locks; the R16 matrix stands on the
  operator's live guide. Preflight only reads settings.

### R22 — Required custom fields and lock minimum (operator statements)

- FACT: (a) A required custom field makes a value mandatory at create time; recreation tries to
  match the source value first. (b) The minimum lock date is 24 hours — an entry whose start is
  less than 24 hours old can never be in a locked period.
- EVIDENCE: operator statements 2026-08-08 (consistent with P-CF-REQ design and the force-timer
  guide's lock matrix).
- CONFIDENCE: operator-stated (authoritative product input); rejection behavior covered by R15.
- CONSEQUENCE: P-CF-REQ resolution order is: source value → current default → user input
  (mandatory). P-LOCK-REG skips its warning entirely for entries younger than 24 hours.

### R24 — A gone project reads back as 400 code `501`, not 404

- FACT: `GET /workspaces/{ws}/projects/{id}` for a project that no longer exists returns
  `400 {"message":"Project doesn't belong to Workspace","code":501}`. This holds both for an id
  that never existed and for a project that was created, archived, and then deleted — the
  deletion case was probed deliberately, because the two could have differed. A 404 from that
  route is therefore not the signal that a project is gone. Separately: an unknown **workspace**
  id returns a 404 with an entirely empty body (the code-absent case R15 records), while an
  unknown **route** returns 404 with body code `3000` — so "404" and "no body code" are
  independent conditions.
- EVIDENCE: `evidence/error-shapes-2026-08-08.md` (developer environment, addon token; the
  create/archive/delete steps used the operator's dev API key because the addon token correctly
  lacks `PROJECT_WRITE`).
- CONFIDENCE: PROVED (2026-08-08).
- CONSEQUENCE: P-PROJ-GONE triggers on 404 **or** 400 body code `501` from `projects.get`, scoped
  to that lookup only; every other error fails the preflight honestly. Corrects docs/03 §2,
  docs/04, and docs/07 §2–§3, which previously said "404 = gone". Without this the most common
  recovery scenario — the project was deleted after the entry — would surface as "Clockify could
  not be reached" instead of the replacement picker. `tasks.list`/`tags.list` are unaffected.

### R21 — Invoice state is invisible on entries

- FACT: `PATCH /time-entries/invoiced` returns 200 but the entry read model never exposes the
  flag (`isInvoiced:null`; no invoice key in GET or list). Invoiced entries delete normally (204)
  and their deletion webhook carries no invoice field.
- EVIDENCE: live round-2 probes A9/B2 (2026-08-08).
- CONFIDENCE: PROVED.
- CONSEQUENCE: Recreation never carries invoice linkage and can never detect one from entry data.
  The UI's invoice difference line is unconditional (R9).

### R23 — The addon token reaches every preflight read route

- FACT: The SDK warns that Clockify walls some endpoint families off from addon tokens regardless
  of manifest scopes (`mapAddonTokenRestriction` docstring names webhooks, custom-field
  management, and account-level `GET /workspaces`). Two preflight reads sat inside that risk and
  were never probed. Fresh-pass probes on the developer environment with the captured addon token:
  `workspaces.get` → 200 with 69 `workspaceSettings` keys (`forceProjects:true`,
  `timeTrackingMode:"DEFAULT"`, `lockTimeEntries:null`, `automaticLock:null`,
  `onlyAdminsCanChangeBillableStatus:false`, `defaultBillableProjects:true`);
  `customFields.listForWorkspace` (`entity-type: ["TIMEENTRY"]`) → 200 with a bare array.
- EVIDENCE: `evidence/fresh-pass-2026-08-08.md` FP-3/FP-4.
- CONFIDENCE: PROVED (reachability, developer environment 2026-08-08). The custom-field **item
  shape** (`type`, `allowedValues`, `required`, `status`, `workspaceDefaultValue`) is SDK-typed
  only — the dev workspace holds zero custom fields, so no live item was seen. LV-08 pins it.
- CONSEQUENCE: Preflight's settings and custom-field lookups are not addon-token restricted.
  The read-only account-level `workspaces.list` is never called; `workspaces.get` is
  workspace-scoped and reachable. All P-CF-* rules rest on the SDK item shape until LV-08.

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

### S3 — Installation token carries a far-future expiry; per-installation storage is consumer-built

- FACT: The `INSTALLED` payload carries `authToken` and per-webhook tokens. The `authToken` **does
  carry an `exp` claim**, set about a century out: the captured developer-environment token has
  `exp: 4939751754` (2126-07-15), alongside `iss: "clockify"`, `sub: "restoretime"`,
  `type: "addon"`, `workspaceId`, `addonId`, and the backend URLs. Earlier wording said "no
  expiry"; that was wrong in letter, right in effect. The SDK ships the
  `ClockifyInstallationStore` interface, an AES-256-GCM encryption wrapper, and an in-memory
  implementation only.
- EVIDENCE: `evidence/fresh-pass-2026-08-08.md` FP-5 (token re-check 2026-08-08).
- CONFIDENCE: PROVED (one installation).
- CONSEQUENCE: Treat the installation token as non-expiring operationally — never build a refresh
  path, a renewal timer, or an expiry warning for it. But never assume the claim is absent: any
  code that reads the token's claims must handle `exp` being present. The app implements one
  durable store over its database and wraps it with the SDK encryption codec. Rejection is still
  detected the same way, by 401 code `"4017"` at call time (R11), never by reading `exp`.

### S4 — Clockify REST SDK behavior

- FACT: Recorded in `docs/04-sdk-integration-map.md` (routes, models, create-for-user support,
  error model) after source inspection.
- CONSEQUENCE: Any route/serialization defect found there is a blocking dependency fixed upstream,
  not worked around in the app (AGENTS.md).

### S5 — Platform signer is shared across environments

- FACT: The developer environment (`developer.clockify.me`) signs addon JWTs with the same pinned platform key as production: the INSTALLED lifecycle and webhook verification passed with `createClockifySignatureParser(addonKey)` defaults (install-capture 2026-08-08).
- CONFIDENCE: PROVED (one install).
- CONSEQUENCE: One parser works in both environments; only `CLOCKIFY_PARENT_ORIGIN` differs (production `https://app.clockify.me`, developer `https://developer.clockify.me`).

### S6 — Clockify REST SDK type facts the app must match exactly

- FACT (source-verified at the then-pinned `clockify-sdk-ts-115@2.0.0`, 2026-08-08; the app moved to
  `@4.0.0` on 2026-08-09 — every item below still holds except the first, which is annotated):
  - `getErrorCode(err)` accepts only **string** body codes (`errors.ts`: `typeof direct === "string"`).
    Clockify sends numbers → it returns `undefined`. The app uses its own normalizer (R15, docs/03 §6).
    *(Superseded by `@3.0.0`, which reads numeric codes. The normalizer is kept deliberately — it
    pins this app's classification against a dependency change — and UT-M01 now asserts the two
    agree instead of that they differ.)*
  - `CustomFieldStatus = "INACTIVE" | "VISIBLE" | "INVISIBLE"` — there is **no** `"ACTIVE"` member.
    "Active field" means `status !== "INACTIVE"` (matches L6: VISIBLE and INVISIBLE fields both
    auto-attach).
  - `ListForWorkspaceCustomFieldsRequest["entity-type"]` is `CustomFieldEntityType[]`
    (`"TIMEENTRY" | "USER"`), so the call passes `["TIMEENTRY"]`. The wire form is repeated
    `entity-type=TIMEENTRY` query params.
  - `CustomField` carries `workspaceDefaultValue` (not `defaultValue`) and every property except
    none is optional — under `exactOptionalPropertyTypes` each read needs an explicit undefined branch.
  - `TaskStatus = "ACTIVE" | "DONE" | "ALL"`; `Tag.archived: boolean`; `UserDtoV1.status` is typed
    `AccountStatus` (drift, docs/03 note 1) but `"ACTIVE"` is a member, so `=== "ACTIVE"` typechecks.
  - `CreateForUserTimeEntriesRequest` is a **union** of a flattened shape and a `{body: …}`
    envelope. The app always builds the flattened variant (`CreateForUserTimeEntriesRequestFlattened`).
  - `iterAll` yields items only; `iterPages` yields `{items, page, pageSize, hasNextPage}`. Only
    `iterPages` can detect the page bound the design requires (docs/03 note 5).
  - `iterAll`/`iterPages`/`getErrorCode` are exported from the package root (`wrapper/index.ts`).
- EVIDENCE: `evidence/fresh-pass-2026-08-08.md` §SDK source re-verification.
- CONSEQUENCE: docs/03, docs/04, docs/07 and PASS-02 state these shapes verbatim. A weaker
  implementation model must not infer them.

## Evidence hierarchy (standing rule)

1. Current controlled live behavior reproduced independently.
2. Tie-breaker live evidence.
3. SDK source + tests.
4. Corrected OpenAPI.
5. Official OpenAPI.
6. Documentation.
7. Assumption (never architecture-load-bearing).
