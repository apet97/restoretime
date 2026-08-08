# 13 — Testing

Tests exist because a behavior is dangerous when wrong, not to raise coverage. Every test maps to a
requirement (docs/02) or an edge case (docs/11). IDs are stable; docs reference them.

## Unit (pure, fast) — `tests/unit/`

| ID | Subject | Defends |
|---|---|---|
| UT-N01 | Webhook guard: rejects malformed bodies (missing id/workspaceId/timeInterval.start; wrong types) | Contract violation handling |
| UT-N02 | Normalization: flat payload → DeletedTimeEntry; embedded task/tags IDs; running shape (`end:null`) | Boundary model correctness |
| UT-P01…P16 | Preflight rules P-RUN, P-PROJ-*, P-TASK-*, P-TAG-*, P-DESC, P-CF-*, P-BILL, P-LOCK*, P-TYPE, P-TIMER, collision cases | Deterministic plan decisions |
| UT-F01 | Fidelity classification matrix (FULL/ADJUSTED/PARTIAL/IMPOSSIBLE from rule outcomes) | Honest fidelity labels |
| UT-S01 | Plan `sourceHash` mismatch → STALE | Tamper/drift guard |
| UT-S02 | Revalidation detects changed dependency → STALE | TOCTOU guard |
| UT-A01 | Policy: admin vs regular vs wrong-owner vs wrong-workspace | Authorization |
| UT-X01 | HTML escaping of descriptions/names with entities and markup-looking text | XSS |
| UT-M01 | Clockify error mapping: HTTP status + body code → user-facing reason (400/501, 401/4017, 403/4030 force-timer, 403/1003 locked) | Failure honesty |
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

Mock transport: a stub `fetch` injected into `createClockifyClient`, driven by recorded response
shapes (create 201, get, listForUser, errors). The Clockify SDK stays real; only the network is
stubbed.

## Live suite (sacrificial workspace, release gate) — `tests/live/`

Runs only with env credentials (`CK_LIVE_API_KEY`, `CK_LIVE_WS`) and only in the release workflow.
Small and deterministic; not the whole exploratory campaign.

| ID | Scenario |
|---|---|
| LV-01 | Addon installs on the sacrificial workspace; component loads with verified claims; `frame-ancestors` correct |
| LV-02 | Delete an entry → webhook arrives at the deployed addon → row appears |
| LV-03 | Own-entry recreation end-to-end (plan → confirm → RECREATED; entry visible in Clockify; a non-default custom-field value is preserved on the new entry — R5 write path) |
| LV-04 | Admin recreates another user's entry (createForUser addon-token success path — confirms the operator-stated API-key/addon-token equivalence, R11) |
| LV-05 | Missing project → ACTION_REQUIRED → substitute → success; archived-tag rejection surfaced correctly (behavior proved by probe A4, R18 — confirmed here on the addon-token path) |
| LV-06 | ~~Archived-tag create behavior~~ merged into LV-05 (offline proof: A4) |
| LV-07 | `onlyAdminsCanChangeBillableStatus` behavior for a regular viewer (closes R12 unknown) |
| LV-08 | Custom-field lifecycle: removed option → P-CF-OPT resolution; new required field without default → P-CF-REQ input → success |
| LV-09 | Reconcile-read pinning on the real addon path: description-filtered `listForUser` reflects a fresh create immediately (round-2 API-key proof: A1/A2); fingerprint round-trip (start/end epoch, description bytes, tagIds set); running entry visible with `end:null` in the unfiltered list. The windowed query is never used (R10) |
| LV-10 | Mandatory ambiguity drill via the chaos hook: the suite runs the app with `RT_CHAOS_FETCH=lose-response` (test-only env flag; the app's fetch wrapper performs the real `createForUser` POST, then reports a transport timeout to the caller). (a) Lose-after-commit → the entry exists in Clockify → AMBIGUOUS → reconcile must adopt it → RECREATED. (b) Fail-before-send → nothing committed → bounded reconcile → user "not created" path → IDLE. The flag is rejected at boot unless `NODE_ENV=test` |

## E2E (component flow) — `tests/e2e/`

PASS-03 scope: load the iframe shell against a local server with SDK test-signing helpers
(`@apet97/clockify-addon-sdk/testing`), drive list → detail → preflight → confirm with a mocked
Clockify API, assert rendered states (ready, warnings, blocked, success, unknown-result). Browser:
agent's choice of the repo-standard tool; keep it one small suite.

## Commands

```bash
npm run test            # unit + contract + integration (no network)
npm run test:live       # live suite — env-gated, release workflow only
npm run test:e2e        # component flow
npm run typecheck && npm run lint
```
