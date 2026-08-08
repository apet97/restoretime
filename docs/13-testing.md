# 13 — Testing

Tests exist because a behavior is dangerous when wrong, not to raise coverage. Every test maps to a
requirement (docs/02) or an edge case (docs/11). IDs are stable; docs reference them.

## Unit (pure, fast) — `tests/unit/`

| ID | Subject | Defends |
|---|---|---|
| UT-N01 | Webhook guard: rejects malformed bodies (missing id/workspaceId/timeInterval.start; wrong types) | Contract violation handling |
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
| UT-M01 | Clockify error mapping through `clockifyErrorCode` (docs/03 §6): body `{"code": 501}` (a JSON **number**) → `"501"`; 400/`"501"`, 401/`"4017"`, 403/`"4030"` force-timer, 403/`"1003"` locked → their user-facing reasons; **code-absent 404** → status-only reason; non-`ClockifyApiError` → `undefined`. A test asserting the SDK `getErrorCode` returns these codes must fail — it returns `undefined` for numeric codes (R15, FP-1/FP-2) | Failure honesty |
| UT-L01 | Lineage linking on ingestion (webhook id == existing `new_entry_id`) | Chain A→B→C |

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
| IT-03 | Concurrent recreate claims → exactly one winner; loser gets current state |
| IT-04 | Ambiguous protocol: commit-lost → reconcile adopts; nothing-committed → user marks; two candidates → user picks |
| IT-05 | Dependency deleted between plan and create → 4xx → FAILED with mapped reason |
| IT-06 | Recreated entry deleted → new row with parent link |
| IT-07 | Authorization negatives: other-user entry 404; demoted admin 403; cross-workspace 404 |
| IT-08 | Clockify 401 code 4017 on any call → installation marked broken |
| IT-09 | Forged workspace/body identity ignored |
| IT-10 | Dismissed entry absorbs redelivery |
| IT-11 | Uninstall purges all workspace rows |
| IT-12 | Lease expiry: crashed attempt is reclaimable; fenced writes reject stale tokens |
| IT-13 | Create returns 201 but the verification `get` fails after read-retries → still RECREATED, diff falls back to the 201 body, "verification read unavailable" recorded (fact 11) |
| IT-14 | Page bound reached: the stub transport returns full pages past `maxPages: 10` → preflight fails with "workspace too large to verify; try again", and an AMBIGUOUS reconcile stays AMBIGUOUS and reports the bound. Never a partial baseline (docs/03 note 5, docs/07 §8) |

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
  installed on `developer.clockify.me`; the operator supplies it, and it never enters the repo.
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
| DS-03 | `users.list` + `projects.list` + `timeEntries.createForUser` + `timeEntries.get` + `timeEntries.delete` round-trip with the exact request shapes docs/03 §2–§3 mandate. Probe descriptions are prefixed `RT-PROBE-` and every created entry is deleted | R11 request shapes as the app builds them |

Gate: DS-01…DS-03 pass, or the PASS-02 report records "blocked" with the exact missing variable.
`LV-01…LV-10` and the docs/16 release gates are unchanged.

## Live suite (sacrificial workspace, release gate) — `tests/live/`

Runs only with env credentials (`CK_LIVE_API_KEY`, `CK_LIVE_WS`) and only in the release workflow.
Small and deterministic; not the whole exploratory campaign.

| ID | Scenario |
|---|---|
| LV-01 | Addon installs on the sacrificial workspace; component loads with verified claims; `frame-ancestors` correct and the sidebar icon (`iconPath`) renders |
| LV-02 | Delete an entry → webhook arrives at the deployed addon → row appears (addon-mode delivery already proved on the developer environment 2026-08-08 — evidence/install-capture-2026-08-08.md; re-confirm on production) |
| LV-03 | Own-entry recreation end-to-end (plan → confirm → RECREATED; entry visible in Clockify; a non-default custom-field value is preserved on the new entry — R5 write path) |
| LV-04 | Admin recreates another user's entry (createForUser addon-token success path — confirms the operator-stated API-key/addon-token equivalence, R11) (the same scenario passed on the developer environment 2026-08-08 with the addon token — users.list, projects.list, createForUser for another user → 201, get, delete; re-confirm on production) |
| LV-05 | Missing project → ACTION_REQUIRED → substitute → success; archived-tag rejection surfaced correctly (behavior proved by probe A4, R18 — confirmed here on the addon-token path) |
| LV-06 | ~~Archived-tag create behavior~~ merged into LV-05 (offline proof: A4) |
| LV-07 | `onlyAdminsCanChangeBillableStatus` behavior for a regular viewer (closes R12 unknown) |
| LV-08 | Custom-field lifecycle: removed option → P-CF-OPT resolution; new required field without default → P-CF-REQ input → success |
| LV-09 | Reconcile-read pinning on the real addon path: description-filtered `listForUser` reflects a fresh create immediately (round-2 API-key proof: A1/A2); fingerprint round-trip (start/end epoch, description bytes, tagIds set); running entry visible with `end:null` in the unfiltered list. The windowed query is never used (R10) |
| LV-10 | Mandatory ambiguity drill via the chaos hook: the suite runs the app with `RT_CHAOS_FETCH=lose-response` (test-only env flag; the app's fetch wrapper performs the real `createForUser` POST, then reports a transport timeout to the caller). (a) Lose-after-commit → the entry exists in Clockify → AMBIGUOUS → reconcile must adopt it → RECREATED. (b) Fail-before-send → nothing committed → bounded reconcile → user "not created" path → IDLE. The flag is rejected at boot unless `NODE_ENV=test` |

## E2E (component flow) — `tests/e2e/`

PASS-03 scope: load the iframe shell against a local server with SDK test-signing helpers
(`@apet97/clockify-addon-sdk/testing`), drive list → detail → preflight → confirm with a mocked
Clockify API, assert rendered states (ready, warnings, blocked, success, unknown-result).

Runner: **vitest with the `happy-dom` environment**, scoped to `tests/e2e/`. This suite exercises
the real esbuild bundle and the SDK bridge (which takes an injected `window`), and it is the only
place a DOM environment is used. It deliberately does **not** attempt real-browser verification:
CSP, `frame-ancestors`, iframe embedding, and console cleanliness belong to LV-01 against a live
deployment and to PASS-04's XSS proof. Keep it one small suite.

## Commands

```bash
npm run test            # unit + contract + integration (no network)
npm run test:dev-smoke  # DS-01…DS-03 — env-gated, additive, never a release gate
npm run test:live       # LV suite — env-gated, release workflow only
npm run test:e2e        # component flow
npm run typecheck && npm run lint
```
