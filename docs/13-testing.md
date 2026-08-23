# 13 — Testing

Tests exist because a behavior is dangerous when wrong, not to raise coverage. Every test maps to a
requirement (docs/02) or an edge case (docs/11). IDs are stable; docs reference them.

## Unit (pure, fast) — `tests/unit/`

| ID | Subject | Defends |
|---|---|---|
| UT-N01 | Webhook guard: rejects malformed bodies, including missing interval `end` or `timeZone`, a running timestamp end, a stopped null end, blank time zones, invalid timestamps, and wrong types. It accepts a running `end:null` and a null time zone without rewriting source strings. | Contract violation handling |
| UT-N02 | Normalization: flat payload → DeletedTimeEntry; embedded task/tags IDs; running shape (`end:null`) | Boundary model correctness |
| UT-P01 | P-RUN / P-RUN-END: running source without `runningMode` → ACTION_REQUIRED with the single-timer auto-stop warning; `completed` mode with `completedEnd ≤ start` → ACTION_REQUIRED | docs/07 §3 |
| UT-P02 | P-PROJ-GONE: source project 404 and no choice → ACTION_REQUIRED replacement picker; "No project" offered only when `!forceProjects` | docs/07 §3 |
| UT-P03 | P-PROJ-ARCH: effective project `archived` → warning `ARCHIVED_PROJECT`, never a blocker (R6) | docs/07 §3 |
| UT-P04 | P-TASK-GONE / P-TASK-CTX: task missing or `status !== "ACTIVE"`; project substituted while a source task is set | docs/07 §3 |
| UT-P05 | P-TAG-GONE / P-TAG-REQ: missing tag → per-tag ACTION_REQUIRED; all tags dropped with `forceTags` and no `addTagIds` → ACTION_REQUIRED | docs/07 §3 |
| UT-P06 | P-TAG-ARCH: archived tag → ACTION_REQUIRED (archived tags reject creation, R18), not a warning | docs/07 §3 |
| UT-P07 | P-OWNER: owner absent from `users.list` or membership `status !== "ACTIVE"` → blocker `OWNER_UNAVAILABLE`; no owner picker | docs/07 §3 |
| UT-P08 | P-PROJ-REQ: `forceProjects` and no effective project in completed mode → ACTION_REQUIRED; running mode resolves it (R4) | docs/07 §3 |
| UT-P09 | P-DESC: `forceDescription` and empty effective description → ACTION_REQUIRED | docs/07 §3 |
| UT-P10 | P-BILL: `onlyAdminsCanChangeBillableStatus` or `defaultBillableProjects` set, viewer not admin, source `billable` differs → warning `BILLABLE_MAY_CHANGE` (R12 probe A5) | docs/07 §3 |
| UT-P11 | P-LOCK / P-LOCK-REG: admin viewer → rule does not apply; regular viewer with a lock setting and `source.start` ≥ 24 h old → warning; younger than 24 h → no warning (R22). The rule never parses lock dates and never blocks | docs/07 §3 |
| UT-P12 | P-CF-GONE: field absent or `status === "INACTIVE"` → warning `CF_FIELD_GONE`, value not sent, fidelity PARTIAL | docs/07 §3 |
| UT-P13 | Reconcile fingerprint collisions: two identical candidates → stay AMBIGUOUS, user picks; a manual copy inside the window yields ≥2 | docs/07 §8 |
| UT-P14 | P-TYPE: `source.type !== "REGULAR"` → blocker `TYPE_NOT_SUPPORTED` (R17) | docs/07 §3 |
| UT-P15 | P-TIMER: `timeTrackingMode === "STOPWATCH_ONLY"`, plan sends `end`, viewer not admin → blocker `TIMER_REQUIRED` with the admin handoff; admin viewer or running-mode plan → no blocker (R16) | docs/07 §3 |
| UT-P16 | P-CF-KEEP / P-CF-WRITE / P-CF-OPT / P-CF-REQ: value equal to `workspaceDefaultValue` → nothing sent; differing value → one `customFields` item `{customFieldId, sourceType:"WORKSPACE", value}`; dropdown value outside `allowedValues` → three-choice ACTION_REQUIRED (R19); `required` field with no usable value → ACTION_REQUIRED after source→`workspaceDefaultValue` resolution (R22). The `customFieldValues` key is never produced | docs/07 §3 |
| UT-F01 | Fidelity classification matrix (FULL/ADJUSTED/PARTIAL/IMPOSSIBLE from rule outcomes) | Honest fidelity labels |
| UT-S01 | Plan `sourceHash` mismatch → STALE | Tamper/drift guard |
| UT-S02 | Revalidation detects changed dependency → STALE | TOCTOU guard |
| UT-A01 | Policy: admin vs regular vs wrong-owner vs wrong-workspace | Authorization |
| UT-X01 | HTML escaping of descriptions/names with entities and markup-looking text | XSS |
| UT-M01 | Clockify error mapping through `clockifyErrorCode` (docs/03 §6): body `{"code": 501}` (a JSON **number**) → `"501"`; 400/`"501"`, 401/`"4017"`, 403/`"4030"` force-timer, 403/`"1003"` locked → their user-facing reasons; **code-absent 404** → status-only reason; non-`ClockifyApiError` → `undefined`. Also pins that the SDK `getErrorCode` agrees with the app normalizer on every shape the app classifies on — it did not before `clockify-sdk-ts-115@3.0.0`, and this assertion is what makes a future divergence fail here instead of in a result view (R15, FP-1/FP-2) | Failure honesty |
| UT-M02 | `safeErrorSummary` (docs/12 "Sensitive log leakage", docs/14 "Logging"): a `ClockifyApiError` never surfaces `.message`/`.body` (which embed the full response verbatim) — only `{errorName, errorStatus, errorCode}`; a plain `Error` yields `{errorName, errorMessage}`; a non-`Error` throw degrades to `{errorName:"unknown"}` | Log-safe error fields |
| UT-L01 | Lineage linking on ingestion (webhook id == existing `new_entry_id`) | Chain A→B→C |
| UT-L02 | Admin name filters at the store (docs/10 §2): substring match on the stored `ownerName`/`projectName`, ASCII case folded; `%`, `_` and `\` in a name are matched literally, not as wildcards; a `null` project name and an empty owner name never match; the name filters narrow alongside the id filters rather than replacing them. Pins the ASCII-only limit explicitly (`Ötzi` ≠ `ötzi`) so the documented caveat is asserted, not assumed | Filter honesty |
| UT-L03 | Admin list state filters at the store (docs/10 §2): `status` and `dismissed` both select a `lifecycle_state`, so each works alone and a request carrying both resolves to one state instead of being ANDed into `lifecycle_state = 'FAILED' AND lifecycle_state = 'DISMISSED'` — a contradiction that matches nothing and reads as "no such entries exist". Verified real: restoring the old two-clause form makes the contradiction case fail with an empty list | Filter honesty |

## Contract (fixture-pinned) — `tests/contract/`

PASS-02 copies the webhook campaign's `sanitized-payloads/` samples into `tests/fixtures/webhook/`
(they are already sanitized; verify on copy).

| ID | Subject |
|---|---|
| CT-01 | S1 baseline fixture normalizes to the expected DeletedTimeEntry |
| CT-02 | S12 update→delete fixture carries final values after normalization |
| CT-03 | S4 description-variant fixtures round-trip byte-exact |
| CT-04 | S9 running fixture → `wasRunning:true, end:null` |
| CT-05 | S2 maximum-info fixture: project/task/tags/CF fields all captured |

## Integration (real DB + mocked Clockify transport) — `tests/integration/`

| ID | Subject |
|---|---|
| IT-01 | Duplicate webhook delivery → one row, both 204 |
| IT-02 | Wrong webhook token / unknown installation → 401, no row |
| IT-03 | Concurrent recreate claims → exactly one winner; loser gets current state. **PASS-04 extension** (`tests/integration/concurrency-workers.test.ts`): the same invariant proved again under real process-level parallelism — 8 `node:worker_threads` workers, each with its own SQLite connection, racing to claim one row on one shared database file; exactly one `claimed:true` |
| IT-04 | Ambiguous protocol: commit-lost → reconcile adopts; nothing-committed → user marks; two candidates → user picks. The SDK 5.1 regression sends an explicit 304 `ClockifyApiError` through the real client. `classifyWriteOutcome()` returns `unknown`; the app reports it and keeps the result, row, and attempt AMBIGUOUS. **PASS-04 extension** (`tests/integration/ambiguous-soak.test.ts`): one scripted soak covering all three phases plus a fourth — two *different* rows both resolving to the same Clockify id via the real `/api/entries/resolve-ambiguous` route; exactly one 409, the loser stays AMBIGUOUS |
| IT-05 | Dependency deleted between plan and create → 4xx → FAILED with mapped reason |
| IT-06 | Recreated entry deleted → new row with parent link |
| IT-07 | Authorization negatives: other-user entry 404; demoted admin 403; cross-workspace 404. **PASS-04 extension** (`tests/integration/permission-negatives.test.ts`, 57 cases): every `/api/*` route against five forgeries (expired token, wrong-addon-key token, cross-workspace viewer, other-member viewer, demoted admin), each asserting the exact failure mode and that no row changed |
| IT-08 | Clockify 401 code 4017 on any call → installation marked broken |
| IT-09 | Forged workspace/body identity ignored. **PASS-04 extension**: the same sweep as IT-07 above (`tests/integration/permission-negatives.test.ts`) covers forged workspace and forged user identity across every route |
| IT-10 | Dismissed entry absorbs redelivery |
| IT-11 | Uninstall purges the rows the *installation* owns, scoped by `(workspace_id, addon_id)`, in one transaction — another generation of the same workspace and another workspace are both untouched, and a repeated `DELETED` reports `stale` and changes nothing (`tests/integration/uninstall.test.ts`) |
| IT-12 | Lease expiry: an expired claim with no attempt is reclaimable. An expired claim with a started attempt becomes `AMBIGUOUS`, because the create request can have reached Clockify. A stored `FAILED` attempt becomes `FAILED`. A stored `SUCCESS` attempt with a new entry ID becomes `RECREATED`. Fenced writes reject stale tokens. `tests/integration/lease-fencing-drill.test.ts` crashes the real recreate handler after the attempt starts but before the create call through the test-only `RT_TEST_CRASH_MID_ATTEMPT` flag. The flag is rejected unless `NODE_ENV==="test"`. `tests/integration/ambiguous-write-recovery.test.ts` covers stale workers, stored outcomes, and atomic rollback. The route uses the real claim code; the store tests supply the expired time directly. |
| IT-13 | Create returns 201 but the verification `get` fails after read-retries → still RECREATED, diff falls back to the 201 body, "verification read unavailable" recorded (fact 11) |
| IT-14 | Page bound reached: the stub transport returns full pages past `maxPages: 10`; `PaginatedList.collect()` reports `truncated: true` → preflight fails with "workspace too large to verify; try again", and an AMBIGUOUS reconcile stays AMBIGUOUS and reports the bound. Never a partial baseline (docs/03 note 5, docs/07 §8) |
| IT-15 | Log audit (docs/12 "Sensitive log leakage", docs/14 "Logging"; `tests/integration/log-audit.test.ts`). Captures `process.stdout`/`stderr` during a scripted flow through install, webhook, list, detail, preflight, recreate failure, and uninstall. Sentinel descriptions, custom-field values, installation tokens, and webhook tokens must not appear. This defends the exercised log paths; it is not a static proof of every possible log call. Reverting the `safeErrorSummary` fix made the sentinel appear. |
| IT-16 | Revalidation drill (docs/07 §7, ADR-006; `tests/integration/revalidation-drill.test.ts`, `tests/integration/api-walkthrough.test.ts`). A dependency (the source project) is removed between plan and confirm → the plan is marked STALE, a fresh preflight is returned, AND a call-counting fetch stub proves zero `POST .../time-entries` calls were ever issued — not just that the response says STALE. The signed route walkthrough also proves that cumulative editable controls retain two resolution rounds, keep the current control first, and dedupe `(ruleId, refId)`. |
| IT-17 | Performance sanity + N+1 fix (pass file §Scope item 9; `tests/integration/performance.test.ts`). Seeds 5000 `recoverable_entries` rows (50 actionable across 5 distinct projects, 4950 filler). A counting fetch stub proves `GET /api/entries` issues exactly one project/task lookup set per distinct project (never per row — the PASS-02 N+1 in `fetchEntryWorkspaceState`, fixed by `src/clockify/preflight-data.ts`'s per-request `ProjectTaskCache`); p95 over 15 sequential calls is **recorded** and checked only against a catastrophe ceiling (`LOCAL_P95_CATASTROPHE_MS`), because a wall-clock budget measures spare CPU rather than the code — the load-independent guard is the call-count assertion (non-SLA — see docs/14 "Performance") |
| IT-18 | Metrics emission (docs/14 "Metrics"; `tests/integration/metrics.test.ts`). One scripted flow touches every documented emission point (webhook received/rejected/duplicate/after_uninstall, recoverable_created, preflight_blockers/action_required, recreate_attempt/success/failed/ambiguous, ambiguous_adopted/not_created, authz_denied); asserts the SET of distinct `metric:*` names emitted equals `METRIC_NAMES` exactly — catches an extra undocumented counter as well as a missing one |
| IT-19 | Error-message sweep (docs/02 N8, docs/10 §8; `tests/integration/error-message-sweep.test.ts`). Drives the real routes into the weakest user-facing failure strings PASS-04 found (several paths shared one bare "Clockify could not be reached; try again" regardless of whether a mutation might be in flight) and asserts the fixed text answers, per situation: what happened, whether anything was created, what to do next. Per-entry list reads also distinguish a rejected addon token from another project-read failure. |
| IT-20 | Name and date filters over `/api/*` (docs/10 §2; `tests/integration/name-filters.test.ts`). An entry on a project Clockify has since deleted is found by its stored project name while that project is absent from `/api/options?kind=projects` — the case an id-resolving filter would silently miss, which is why the design exists. Also: a deactivated member's entry is found by their stored name; `userName` is silently ignored for a non-admin, exactly as `userId` is; `/api/options?kind=users` returns `{id, name}` including deactivated members and 403s a non-admin, while the other option kinds stay open. Strict UTC list bounds accept seconds or one to three fractional digits and are canonical before filtering. An invalid, over-precise, or reversed list bound returns 400 before a row query. |
| IT-21 | Installation-generation isolation (docs/08 "Retention and deletion", docs/09 "Identity"; `tests/integration/installation-generation.test.ts`). A reinstall neither inherits the previous generation's entries nor is blocked by them when capturing the same source entry id; installing supersedes the older generation, which is what stops a missed `DELETED` from retaining data forever; a delayed `DELETED` for a superseded generation is acknowledged and leaves the current one intact; a viewer from one generation gets 404 for another generation's row. A replayed `INSTALLED` for an already-retired generation is still installed but supersedes nothing — lifecycle tokens carry no expiry, so it can arrive at any time and always looks newest. Each assertion was verified red-first against the unscoped code. |
| IT-22 | Uninstall/webhook race (docs/08; `tests/integration/webhook-uninstall-race.test.ts`). A barrier inside `ClockifyInstallationStore.load` holds a delivery at the point production holds it — after the add-on token is loaded and decrypted — the uninstall runs to completion, then the delivery is released and reaches its write. No row is inserted, no false `recoverable_created` is counted, and the delivery is acknowledged because a retry could not succeed. Deterministic: a promise barrier through the `wrapInstallationStore` seam, never a sleep. Removing the SQL fence makes it fail with a row present. |
| IT-23 | Viewer authority (docs/09 "Credential authority"; `tests/integration/viewer-authority.test.ts`). Every Clockify call carries the installation's add-on token, the only credential the platform issues, so a member's own choices are checked first: the project picker omits a private project they are not a member of (name included, not just id), `kind=tasks` answers 404 rather than 403 for one, and a re-targeting `choices.projectId` outside their reach is refused 403 before a plan exists and before any write. An admin is unaffected, and the entry's *own* original project needs no membership check. |
| IT-24 | List traversal (docs/03 `GET /api/entries`; `tests/integration/pagination.test.ts`). 101 identically-filtered rows are each reached exactly once across three pages, in strict order; a shared `detected_at` keeps the boundary deterministic through the id tiebreaker; a row inserted between pages never repeats an already-returned one; a malformed or unsupported-version cursor and an out-of-range `limit` are answered 400 rather than clamped; a cursor cannot reach another installation generation's rows. |

Mock transport: a stub `fetch` injected into `createClockifyClient`, driven by recorded response
shapes (create 201, get, listForUser, errors). The Clockify SDK stays real; only the network is
stubbed.

## Developer-environment smoke (PASS-02, additive) — `tests/dev-smoke/`

Three REST-only checks that need no deployed addon and no tunnel: they run against Clockify's
developer environment with an already-captured installation token. They exist because PASS-02
builds the Clockify read/write client long before PASS-05 can run, and a wrong request shape
should surface then, not at release. They are **additive**: they add no release gate, replace no
`LV-` row, and change nothing in docs/16.

- Command: `npm run test:dev-smoke`. The directory is `tests/dev-smoke/`, deliberately **outside**
  `tests/live/`, so `npm run test:live` never picks it up and the release workflow never runs it.
- Environment (all three required, exact names): `CK_DEV_WORKSPACE_ID`, `CK_DEV_ADDON_ID`,
  `CK_DEV_ADDON_TOKEN`. The token is the installation `authToken` captured when the addon was
  installed on `developer.clockify.me`; it never enters the repo. `scripts/live-env.sh` assembles
  all three (and the `CK_LIVE_*` set) from `.env.live` plus the stored installation — see
  "Assembling the environment" below.
- Precondition: a live installation for that workspace/addon pair. A quick-tunnel restart changes
  `baseUrl` and forces a reinstall (evidence/install-capture-2026-08-08.md), which invalidates the
  captured token — that is the "blocked" case, not a failure.
- With any of the three variables missing, or with the token rejected as 401 code `"4017"`, the
  suite reports "blocked — no valid developer installation" and does **not** fail the pass
  (ROADMAP rule 4).

| ID | Scenario | Closes |
|---|---|---|
| DS-01 | `workspaces.get` and `customFields.listForWorkspace` (`"entity-type": ["TIMEENTRY"]`) succeed with the addon token and deserialize into the SDK models the preflight reads | R23 stays true for the app's own client |
| DS-02 | A deliberate 4xx (create without `projectId` in a `forceProjects` workspace) maps through `clockifyErrorCode` to `"501"`, and a 404 maps with `undefined` | R15 / UT-M01 against live bodies, not fixtures |
| DS-03 | `users.list` + `projects.list` + `customFields.listForWorkspace` + `timeEntries.createForUser` + `timeEntries.get` + `timeEntries.delete` round-trip with the exact request shapes docs/03 §2–§3 mandate, **including the `customFields` arm** for every active required field. Probe descriptions are prefixed `RT-PROBE-` and every created entry is deleted | R11 request shapes as the app builds them |

Gate: DS-01…DS-03 pass, or the PASS-02 report records "blocked" with the exact missing variable.
That developer-smoke repair did not change the then-current live evidence. Later release-harness
changes are specified below and need new candidate-bound proof.

**First run with credentials: 2026-08-09.** Until then every DS row had only ever reported
"blocked", so the suite had never executed. All three pass now, and running it found one thing: the
developer workspace has two **active required custom fields**, and DS-03's create omitted
`customFields` entirely, so Clockify rejected it `400 {"message":" <field names>", "code":501}`.
That is not a product defect — P-CF-REQ resolves those fields before the app ever builds a create
(docs/07 §3, proved live by LV-08) — it means DS-03 was round-tripping a shape *the app cannot
produce*. It now supplies a value for each required field, which makes the row prove more, not
less. Its failure path also surfaces `clockifyErrorDetail(err)`: since `clockify-sdk-ts-115@4.0.0`
an error's `message` is body-free, so a raw rethrow read only "BadRequestError / Status code: 400"
and named no field — useless in the one suite whose purpose is real response bodies. That accessor
is confined to `tests/dev-smoke/`; `src/` still reaches Clockify errors only through
`safeErrorSummary` (docs/12, IT-15).

## Live suite (sacrificial workspace) — `tests/live/`

The suite accepts only `CK_LIVE_TARGET=developer` and
`CK_LIVE_API_BASE=https://developer.clockify.me/api`. There is no production default. It verifies
the exact API-key user ID and active membership, and the exact workspace, add-on ID, add-on key,
installation API URL, deployed HTTPS origin, and candidate identity. In strict mode, it also
decodes the installation-token JWT payload without logging it. The `iss`, `sub`, `type`,
`workspaceId`, and `addonId` claims must match the release target. A present `exp` claim must be a
finite future timestamp. The REST reads remain the credential-validity proof.

`npm run test:live` is diagnostic. A missing prerequisite prints `BLOCKED` and can still leave the
command green. It is not release proof. `npm run test:live:release` is fail-closed: every missing
credential, host, workspace shape, candidate receipt, or cleanup result fails the command. A valid
strict run has zero skipped tests. The cleanup process runs even when a scenario fails. It pages
all current and deactivated workspace users and every returned time-entry page, deletes every entry whose description starts
`RT-PROBE-`, and fails unless a second bounded all-user scan finds zero. Release teardown also
scans active and inactive tags and custom fields, deletes every artifact whose name starts
`RT-PROBE-`, and fails unless a second bounded scan finds zero.

LV-03…LV-10 boot the app's own `createServer()` in-process with a **test-signed platform key**
(`@apet97/clockify-addon-sdk/testing`, the same helper every offline integration test already uses
— `generateTestKeys`/`signTestToken`) so the JWT-verification boundary (installation, component
auth) is exercised through the real SDK verification code path without needing Clockify's private
signing key. The Clockify REST boundary is not faked. The installation row uses the real
installation add-on token from `CK_LIVE_ADDON_TOKEN` and the API URL from `CK_LIVE_API_BASE`.
Every app request goes to the real sacrificial workspace with `X-Addon-Token`. The API key is used
only by the direct probe client from `buildLiveRestClient`.

LV-01 and LV-02 are different. They include deployed-artifact and Clockify-issued evidence that a
test-signed key cannot produce. Each row therefore has an automated A claim and an operator B
receipt. The B receipt must name the exact target, workspace, add-on ID, add-on key, deployed URL,
and `CK_LIVE_CANDIDATE_ID`. Old receipts do not prove a new candidate.

| ID | Scenario |
|---|---|
| LV-01A | Automated: verify the developer workspace identity, deployed `/healthz`, manifest identity, icon and bundle, and the unauthenticated `/component` boundary. |
| LV-01B | Receipt: the authenticated developer iframe rendered for this candidate, the sidebar icon rendered, the deleted-entry list loaded, the response used `frame-ancestors https://developer.clockify.me`, and the app console and CSP error counts were both zero. |
| LV-02A | Trigger-only command: create and delete one probe and print its exact `sourceEntryId`. This file is excluded from diagnostic and release collection. |
| LV-02B | Receipt: Railway webhook logs correlate the deployed candidate to the exact `CK_LIVE_LV02_SOURCE_ID` printed by LV-02A, and direct inspection of remote SQLite finds the persisted source row with that ID. The strict run creates no second trigger. |
| LV-03 | Own-entry recreation end-to-end (plan → confirm → RECREATED; entry visible in Clockify; a non-default custom-field value is preserved on the new entry — R5 write path) |
| LV-04 | Admin recreates another user's entry (createForUser add-on-token success path — confirms the operator-stated API-key/add-on-token equivalence, R11). The same scenario passed on the developer environment on 2026-08-08 with the add-on token: users.list, projects.list, createForUser for another user → 201, get, delete. A production recheck is a future production-only gap; it is not a developer-candidate gate. |
| LV-05 | Missing project → ACTION_REQUIRED → substitute → success; archived-tag rejection surfaced correctly (behavior proved by probe A4, R18 — confirmed here on the addon-token path) |
| LV-06 | ~~Archived-tag create behavior~~ merged into LV-05 (offline proof: A4). No `tests/live/` file exists for this row |
| LV-07 | `onlyAdminsCanChangeBillableStatus` behavior for a regular viewer (closes R12 unknown) |
| LV-08 | Custom-field lifecycle: removed option → P-CF-OPT resolution; new required field without default → P-CF-REQ input → success |
| LV-09 | Reconcile-read pinning on the real addon path: description-filtered `listForUser` reflects a fresh create immediately (round-2 API-key proof: A1/A2); fingerprint round-trip (start/end epoch, description bytes, tagIds set); running entry visible with `end:null` in the unfiltered list. The windowed query is never used (R10) |
| LV-10 | Mandatory ambiguity drill via the chaos hook (`src/clockify/chaos-fetch.ts`): the suite runs with `RT_CHAOS_FETCH` set (test-only env flag, rejected unless `NODE_ENV=test`, mirroring `RT_TEST_CRASH_MID_ATTEMPT`). Two modes, one per leg: (a) `RT_CHAOS_FETCH=lose-response` — the app's fetch wrapper performs the real `createForUser` POST (Clockify commits it), then reports a `ClockifyApiTimeoutError` to the caller → AMBIGUOUS → reconcile must adopt the committed entry → RECREATED. (b) `RT_CHAOS_FETCH=fail-before-send` — the wrapper throws before the real fetch is ever called → nothing committed → AMBIGUOUS → bounded reconcile finds nothing → user "not created" path → IDLE. The hook mechanics are proved offline against a mocked transport in `tests/integration/chaos-fetch-drill.test.ts`; LV-10 itself repeats both legs against the real sacrificial workspace |

### Assembling the environment

Copy `.env.live.example` to the gitignored `.env.live`. Fill the exact developer target, workspace,
add-on ID, add-on key, full candidate commit, and Railway project, environment, service,
deployment, and deployment-instance IDs. Keep receipt JSON outside the repository.
`scripts/live-env.sh` invokes `railway ssh` with the four exact Railway selectors. It does not use
the linked project, a service name, the newest deployment, `var/live.sqlite`, or `var/key.hex`.

```bash
scripts/live-env.sh https://<exact-railway-origin> npm run test:live:trigger
# Copy the printed source ID to CK_LIVE_LV02_SOURCE_ID. Capture LV-01B and LV-02B receipts.
scripts/live-env.sh https://<exact-railway-origin> npm run test:live:release
```

- Required common values: `CK_LIVE_TARGET`, `CK_LIVE_API_KEY`, `CK_LIVE_API_USER_ID`, `CK_LIVE_WS`,
  `CK_LIVE_API_BASE`, `CK_LIVE_ADDON_ID`, `CK_LIVE_ADDON_KEY`, and
  `CK_LIVE_ADDON_BASE_URL`.
- Strict-release values: `CK_LIVE_CANDIDATE_ID`, `CK_LIVE_LV01B_RECEIPT`,
  `CK_LIVE_LV02_SOURCE_ID`, `CK_LIVE_LV02B_RECEIPT`, `CK_RAILWAY_PROJECT_ID`,
  `CK_RAILWAY_ENVIRONMENT_ID`, `CK_RAILWAY_SERVICE_ID`, `CK_RAILWAY_DEPLOYMENT_ID`, and
  `CK_RAILWAY_DEPLOYMENT_INSTANCE_ID`.
- Both receipts use `schemaVersion: 1` and common fields `row`, `target`, `workspaceId`, `addonId`,
  `addonKey`, `addonBaseUrl`, `candidateId`, `observedAt`, and a nonempty `evidence` reference.
  LV-01B adds `authenticatedComponentRendered: true`, `sidebarIconRendered: true`,
  `deletedEntryListLoaded: true`, `contentSecurityPolicyVerified: true`,
  `frameAncestorsOrigin: "https://developer.clockify.me"`,
  `appConsoleErrorCount: 0`, and `cspErrorCount: 0`. LV-02B adds `sourceEntryId`,
  `railwayWebhookLogCorrelated: true`, and `remoteSqliteRowPresent: true`.
- The remote process verifies Railway's project, environment, service, and deployment variables.
  It also verifies `RESTORETIME_CANDIDATE_ID`, the public origin, `/data` volume path, add-on key,
  and the exact active workspace/add-on row. It decrypts that row inside the deployed container.
  The image contains a deterministic SHA-256 fingerprint of every application source input. The
  local handoff computes the expected fingerprint from the named candidate Git commit and requires
  an exact match. It also requires that the local checkout has that commit as `HEAD` and has no
  tracked or non-ignored untracked change. Under the committed Dockerfile, this check detects
  accidental source drift between the commit and the Railway upload. It is not a signed build
  attestation. It does not defend against an operator who changes the Dockerfile or the fingerprint
  program.
  The independent Railway image digest identifies the deployed artifact. The Dockerfile pins the
  Node base-image index digest. Record the selected platform and build provenance separately. A
  GitHub-triggered deployment must also have a matching
  `RAILWAY_GIT_COMMIT_SHA`.
  `railway up` does not provide that Git-only variable, so its source binding uses the required
  application-source fingerprint.
- The local process generates a one-use public key. The remote process returns only an
  RSA-OAEP-256 and AES-256-GCM encrypted envelope bound to all target IDs. The local process
  decrypts it in memory and starts the command with `CK_LIVE_ADDON_TOKEN`, `CK_DEV_ADDON_TOKEN`,
  `CK_DEV_WORKSPACE_ID`, and `CK_DEV_ADDON_ID`. It never prints or writes the plaintext token or
  an envelope file. `tests/live/railway-live-handoff.test.ts` proves the happy path, exact Railway
  selectors, candidate rejection, token-output boundary, and no-transfer-file rule.
- Strict mode rejects `CK_LIVE_INSTALLATION_SOURCE=local-database`. The local
  `scripts/read-installation.mjs` path remains a diagnostic helper. A local row cannot prove the
  new Railway candidate.
- `CK_LIVE_ADDON_BASE_URL` must be one HTTPS origin. It cannot contain a path, query, fragment, or
  credentials.
- The strict runner holds child output in memory first. It replaces any exact live-secret value
  before it writes output and fails the release if a child emitted a secret.
- Preconditions: an installed add-on on the exact Railway deployment, Railway CLI login, and an
  SSH key that Railway accepts. The deployment must set `RESTORETIME_CANDIDATE_ID` to the same full
  commit as `CK_LIVE_CANDIDATE_ID`.

## E2E (component flow) — `tests/e2e/`

List continuation (`tests/e2e/views.test.ts` "list continuation") covers the **Load more** path:
the next page appends and the rows already shown stay, the server's own `nextCursor` is sent back
verbatim, the button disappears on the last page, and changing a filter starts a fresh sequence
rather than carrying a cursor that names a position in the previous result set.

PASS-03 scope: load the iframe shell against a local server with SDK test-signing helpers
(`@apet97/clockify-addon-sdk/testing`), drive list → detail → preflight → confirm with a mocked
Clockify API, assert rendered states (ready, warnings, blocked, success, unknown-result).

Runner: **vitest with the `happy-dom` environment**, scoped to `tests/e2e/`. `npm run test:e2e`
builds once and then runs the suite. The suite runs the UI
source modules with the SDK bridge and an injected `window`. One test in
`tests/e2e/component-flow.test.ts` also boots the built `dist/static/app.js` bundle. This is the
only place a DOM environment is used. It does not attempt real-browser verification. CSP,
`frame-ancestors`, and iframe embedding belong to LV-01 against a live deployment.

`tests/e2e/component-flow.test.ts`'s "admin list filters by name" case (docs/10 §2) additionally
counts Clockify calls: two further list renders after the first must issue **zero** extra
`/api/options` walks, pinning the per-session suggestion cache. Verified real — removing the cache
lookup makes the count assertion fail.

`tests/e2e/xss-proof.test.ts` (**UT-X01 extension**, PASS-04) drives entity-encoded and
markup-looking payloads in the description, project name, task name, tag names, owner name, and a
custom-field value through every rendered view (list, detail, resolution widgets, confirm,
success/result) through the real `boot()` source path (the built `dist/static/app.js` bundle itself is booted by
`tests/e2e/component-flow.test.ts`), asserting no `img`/`svg`/`script`/`iframe`
element is ever created from stored Clockify text.

The following developer-end-state tests defend the component contracts. They are local proof. They
do not prove a live Clockify installation or a deployed candidate.

| ID | Subject | Defends |
|---|---|---|
| E2E-UI-01 | `tests/e2e/views.test.ts`, `tests/unit/server.test.ts`: persistent shell, screen heading focus, and live announcement | One product H1 remains mounted. Each complete screen focuses and announces its H2. |
| E2E-UI-02 | `tests/e2e/views.test.ts`, `tests/e2e/bulk-not-actionable.test.ts`: busy actions | Two immediate activations make one request. The visible busy label, disabled state, and `aria-busy` state remain available. |
| E2E-UI-03 | `tests/e2e/component-flow.test.ts`, `tests/e2e/bulk-not-actionable.test.ts`: session-local list and bulk state | Detail round trips preserve filters and selection. Filter and mode changes clear hidden selection. Bulk return refreshes preflight. |
| E2E-UI-04 | `tests/e2e/views.test.ts`, `tests/e2e/ambiguous-result-refresh.test.ts`: inline errors and return paths | Action errors keep context. Each error gives one explicit safe next action. Result and session-expired screens give a usable return action. |
| E2E-UI-05 | `tests/e2e/ambiguous-result-refresh.test.ts`, `tests/e2e/xss-proof.test.ts`: human result and ambiguous-match presentation | Buttons do not use raw IDs. Technical references remain closed and text-safe. Result differences do not expose JSON, internal keys, or IDs. |
| E2E-UI-06 | `tests/e2e/ui-layout.test.ts`, `tests/e2e/ui-css.test.ts`, `tests/e2e/custom-field-resolution-widgets.test.ts`: responsive and keyboard contracts | Chrome fixtures contain document layout at required widths. The table keeps local scrolling. Native checkbox groups keep labels and keyboard behavior. |
| E2E-SHUTDOWN-01 | `tests/e2e/server-shutdown.test.ts`: child process shutdown | `SIGTERM` closes the HTTP listener and SQLite database. The process exits 0 within five seconds and database integrity remains `ok`. |

On `main` at `6306c1c` (2026-08-17), `npm run test` passed 44 files and 472 tests. `npm run
test:e2e` passed 12 files and 105 tests. These results are local evidence only. They do not prove
a deployed candidate or a Clockify developer installation.

## Commands

```bash
npm run test            # unit + contract + integration (no network)
npm run test:dev-smoke  # DS-01…DS-03 — env-gated, additive, never a release gate
npm run test:live       # diagnostic; BLOCKED is allowed and is not release proof
npm run test:live:trigger # LV-02A only; prints the exact source ID for the receipt
npm run test:live:release # strict candidate gate plus all-user cleanup verification
npm run test:e2e        # builds once, then runs component flow
npm run typecheck && npm run lint
```
