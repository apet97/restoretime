# Fresh pass — 2026-08-08 (third adversarial pass)

A fresh review of the blueprint after commit `1748667`. Scope: verify that the SDK-verified
corrections hold everywhere, find defects those corrections introduced, and close the remaining
weak spots. Method: SDK source re-inspection at the pinned commits, four live REST probes on the
Clockify developer environment with the captured addon token, and a repository-wide consistency
sweep.

Credentials came from the operator's environment. This repository holds none.

## 1. Live probes (developer environment, addon token)

Workspace `69bda6b317a0c5babe34b4ff`, addon `6a76834a2a539b0829b7a5ae`. Probes ran through the
product's own SDK path (`createClockifyClient({addonToken, baseUrl, timeoutInSeconds: 30})` over
`resolveClockifyApiBaseUrl(installation.apiUrl)`). No probe entry survived: every write attempt in
FP-1 and FP-2 was a deliberate rejection, so nothing was created and nothing needed cleanup.

| # | Probe | Result | Confidence |
|---|---|---|---|
| FP-1 | `createForUser` with no `projectId` in this `forceProjects` workspace | HTTP 400, body `{"message": "Time entry couldn't be created. Project is either required field or given project is archived…", "code": 501}`. **`typeof body.code === "number"`. `getErrorCode(err)` returned `undefined`.** | PROVED |
| FP-2 | Error-shape sweep across three 4xx classes: bad addon token; `workspaces.get` on an unknown workspace; a description containing `<`/`>` | 401 → `code: 4017` (number), `getErrorCode` `undefined`. 404 → **no `code` key at all**, `getErrorCode` `undefined`. 400 → `code: 501` (number), `getErrorCode` `undefined`. All three were `ClockifyApiError` with a correct `statusCode` | PROVED |
| FP-3 | `workspaces.get` with the addon token | 200; `workspaceSettings` carries 69 keys, including `forceProjects: true`, `timeTrackingMode: "DEFAULT"`, `lockTimeEntries: null`, `automaticLock: null`, `onlyAdminsCanChangeBillableStatus: false`, `defaultBillableProjects: true` | PROVED |
| FP-4 | `customFields.listForWorkspace` with `"entity-type": ["TIMEENTRY"]` and the addon token | 200 with a bare array. The workspace holds **zero** custom fields, so no item shape was observed | PROVED (reachability only) |
| FP-5 | Read-only re-check of the captured installation token (`users.list` 10, `projects.list` 36, `workspaces.get` 200) and of its decoded claims | Token still valid. Claims: `iss: "clockify"`, `sub: "restoretime"`, `type: "addon"`, `workspaceId`, and **`exp: 4939751754` = 2126-07-15**. The stored webhook path is still `//webhooks/time-entry-deleted`, re-confirming W17 against a live record | PROVED |

FP-3 and FP-4 close a risk the blueprint never recorded. The Clockify SDK's
`mapAddonTokenRestriction` docstring states that Clockify walls some endpoint families off from
addon tokens regardless of manifest scopes, naming webhooks, **custom-field management**, and
**account-level `GET /workspaces`**. Preflight depends on `workspaces.get` and
`customFields.listForWorkspace`, and the 2026-08-08 install capture had probed neither. Both are
reachable. The account-level `workspaces.list` is never called by this product.

FP-4 proves reachability, not shape. Every `P-CF-*` rule rests on `type`, `allowedValues`,
`required`, `status`, and `workspaceDefaultValue` as the SDK types them. LV-08 remains the row
that pins the live item shape.

## 2. SDK source re-verification

At `addon-ts-sdk` `d86e4597…` (= HEAD) and `clockify-ts-sdk` `b33e5b02…` (HEAD `f2d82d17…`,
docs-only advance). All findings folded into docs/01 S6.

| Claim under test | Source | Outcome |
|---|---|---|
| `getErrorCode` returns body codes as strings | `wrapper/errors.ts` `getErrorCode` requires `typeof direct === "string"` | **WRONG.** Returns `undefined` for numeric codes. Blueprint defect, fixed |
| `iterAll`/`iterPages` exported from the package root | `wrapper/index.ts` re-exports both | Correct |
| `iterAll` can enforce the page bound the design needs | `wrapper/iter.ts`: `iterAll` yields items; only `iterPages` yields `{items, page, pageSize, hasNextPage}` | **WRONG.** The bound is undetectable through `iterAll`. Fixed by switching to `iterPages` |
| `users.list` takes `status: "ALL"` and requires `"include-roles"` | `ListUsersRequest`: `status?: "PENDING" \| "ACTIVE" \| "DECLINED" \| "INACTIVE" \| "ALL"`; `"include-roles": boolean` (required) | Correct |
| `memberships` is a `users.list` query param the app does not use | `ListUsersRequest.memberships?: "ALL" \| "NONE" \| "WORKSPACE" \| "PROJECT" \| "USERGROUP"` | Correct |
| Read retries are `maxRetries: 2` = 3 attempts | matches docs/04 | Correct |
| Custom-field status includes `"ACTIVE"` | `CustomFieldStatus = "INACTIVE" \| "VISIBLE" \| "INVISIBLE"` | **WRONG.** Active means `status !== "INACTIVE"`. Fixed |
| `entity-type` is a scalar | `ListForWorkspaceCustomFieldsRequest["entity-type"]?: CustomFieldEntityType[]` | **WRONG.** It is an array. Fixed |
| `CustomField` exposes `defaultValue` | The field is `workspaceDefaultValue`; every property is optional | **WRONG.** Fixed |
| `CreateForUserTimeEntriesRequest` is one object shape | It is a union: a flattened shape and a `{body: …}` envelope | Imprecise. Fixed — the app always builds the flattened variant |
| `TaskStatus` supports the `status !== "ACTIVE"` test | `TaskStatus = "ACTIVE" \| "DONE" \| "ALL"` | Correct |
| `UserDtoV1.status === "ACTIVE"` typechecks | `AccountStatus` includes `"ACTIVE"` | Correct — the documented drift needs no workaround |

## 3. Findings and disposition

| # | Finding | Severity | Disposition |
|---|---|---|---|
| F-1 | Error classification keyed on the SDK `getErrorCode`, which returns `undefined` for every Clockify numeric body code. Every 4xx would have mapped to "unknown reason", and UT-M01 would have pinned the wrong behavior | **blocking** | Fixed: docs/03 §6 defines the app normalizer `clockifyErrorCode` with its source; docs/01 R15 + S6, docs/04, docs/07 §8, docs/11, docs/13 UT-M01, docs/16, PASS-02, TASK-04 all updated. `getErrorCode` is never imported |
| F-2 | AGENTS.md rule 5 ("never work around an SDK defect in app code — report it as a blocking dependency") would have stopped an implementer at F-1 | **blocking** | Fixed: AGENTS.md rule 5 carries one named, already-decided exception with its reasoning — `getErrorCode` is correct for its documented string-code contract, so this is a gap it never claimed, not a defect. The upstream suggestion is recorded in docs/04 as non-blocking |
| F-3 | Three documents required "a read that hits the page bound fails / stays AMBIGUOUS and reports the bound", but mandated `iterAll`, which cannot report it | high | Fixed: all bounded reads use `iterPages` with the exact stop condition `page === maxPages && hasNextPage` (docs/03 note 5, docs/07 §2/§8, PASS-02, TASK-03/04). New test IT-14 |
| F-4 | `customFields.listForWorkspace` and `workspaces.get` were never probed with an addon token, while the SDK warns that custom-field and account-level workspace routes can be walled off | high | Closed by evidence: FP-3/FP-4, new baseline row R23 |
| F-5 | P-CF rules said "field is active"; the enum has no `"ACTIVE"` member, so the natural implementation (`status === "ACTIVE"`) never matches and every field reads as gone | high | Fixed: "active" defined as `status !== "INACTIVE"` in docs/03 note 6, docs/04, docs/07 §2 and P-CF-KEEP/WRITE/GONE/REQ, docs/13 UT-P12/UT-P16 |
| F-6 | `entity-type` documented as a scalar; the request type is an array, so the mandated call does not typecheck | high | Fixed: `["TIMEENTRY"]` everywhere it is called; the route prose keeps the wire form `entity-type=TIMEENTRY`, which is correct |
| F-7 | Custom-field default documented as "default"; the field is `workspaceDefaultValue`, and all `CustomField` properties are optional under `exactOptionalPropertyTypes` | med | Fixed: docs/03 note 6, docs/04, docs/07 §2 and the P-CF rows |
| F-8 | `docs/13` collapsed sixteen preflight tests into one `UT-P01…P16` row, so no test had a definition | med | Fixed: sixteen rows, each naming its rule and assertion. The mapping was already implicit in docs/11, so nothing was invented |
| F-9 | 27 citations of the form `fact N` had no defining document | med | Fixed: IMPLEMENTER.md §Evidence citation convention binds `fact N` to row N of `evidence/sdk-verification-2026-08-08.md` and `FP-n` to this file. Cheaper and clearer than renaming 27 citations |
| F-10 | `implementation/DEPENDENCIES.md` §Registry note left "registry vs vendored tarballs" open for PASS-01 | med | Closed: registry, with the evidence. PASS-01 records versions, `integrity` hashes, and the SDK repos' clean status. The open question is gone |
| F-11 | PASS-01/PASS-02 never cited `tools/install-capture/server.mjs`, the only live-proven wiring in the repository | med | Fixed: both passes and TASK-02 cite it, naming exactly what to copy — builder chains, register-then-validate, verifier argument orders, normalized-path token lookup, encrypted store over a backend, `timeoutInSeconds: 30`, error classification |
| F-12 | No live check ran before PASS-05, so a wrong request shape built in PASS-02 would surface months later | med | Fixed: DS-01…DS-03 developer-environment smoke, additive and non-gating, in docs/13 and PASS-02. Made runnable: `npm run test:dev-smoke` (declared in PASS-01), directory `tests/dev-smoke/` outside `tests/live/` so the release runner never picks it up, exact variables `CK_DEV_WORKSPACE_ID` / `CK_DEV_ADDON_ID` / `CK_DEV_ADDON_TOKEN`, and the captured-installation precondition stated. `LV-01…LV-10` and every docs/16 release gate are byte-identical |
| F-13 | `IMPLEMENTER.md` pinned `clockify-ts-sdk` at `b33e5b02…` with no note that HEAD had advanced; docs/04 recorded the advance | low | Fixed: the two tables now agree |
| F-14 | A real workspace member's user id appeared in `evidence/install-capture-2026-08-08.md`; the id identifies a person and proved nothing the sentence did not | low | Fixed: replaced with "a second ACTIVE workspace member, id withheld". Workspace and addon ids are kept — they are opaque resource identifiers, useless without a token, and they make the capture reproducible |
| F-15 | A 9.1 MB `omp-session-*.html` planning artifact was tracked at the repository root | low | Fixed: untracked, deleted, and the pattern gitignored. It is a session transcript, not a blueprint input; nothing cites it. Git history still carries the blob — it holds no credential, so rewriting history would cost more than the bytes |
| F-23 | `docs/14` said "the six variables from docs/05"; the docs/05 §Configuration table lists **seven** (`CLOCKIFY_PARENT_ORIGIN` was added by fact 12 without updating the count). `docs/16` pointed at "docs/05's list" for dependencies, but the closed list is `implementation/DEPENDENCIES.md` | low | Fixed: both pointers corrected |
| F-24 | `docs/03` §6's new code-absent 404 rule read as global, colliding with §2 where `projects.get` 404 means P-PROJ-GONE | low | Fixed: the status-only mapping is scoped to the create call; preflight reads keep their own 404 meanings |
| F-25 | `docs/11` "Invoiced deleted entry" row had `—` in its Test column, the last row without a test or a stated reason | low | Fixed: reason stated — invoice state is invisible on every payload and read model (R21), so no code branches on it |
| F-26 | `docs/01` S3 stated the installation `authToken` has "no expiry". It carries `exp: 4939751754` (2126-07-15) — a century out, so non-expiring in effect but not in letter. A weaker model could skip an `exp` branch because the document said the claim was absent | low | Fixed by evidence: S3 rewritten with the real claim set (FP-5). The operational rule is unchanged — build no refresh path for this token; detect rejection by 401 code `"4017"` at call time, never by reading `exp` |
| F-16 | `docs/11` recorded "Create-for-user for an inactive owner: UNVERIFIED" with no owner for the gap | low | Fixed: stated as an accepted risk — P-OWNER blocks before any create, so the behavior is never exercised and no LV row is needed |
| F-17 | Asserted stale pattern `status=ALL` | — | **Rejected**: `ListUsersRequest.status` accepts `"ALL"`. Not a defect |
| F-18 | Asserted stale pattern `memberships` | — | **Rejected**: it is a real `users.list` query param, and docs/03 note 1 correctly records that the app does not use it. The other two hits are prose about payload fields the app discards |
| F-19 | Asserted stale pattern "2 attempts" | — | **Rejected**: `maxRetries: 2` = 3 attempts is correctly stated in docs/04 and matches the SDK |
| F-20 | Asserted stale patterns `ClockifyManifest.builder()`, `/api/entries/{`, path parameters in route tables | — | **Already correct**: zero hits outside the correction record in `sdk-verification-2026-08-08.md`. The commit-`1748667` corrections held |
| F-21 | Vague instructions in `implementation/` (`appropriate`, `as needed`, `consider`, `if necessary`, `handle edge cases`, `etc.`) | — | **Already correct**: zero hits. The only `etc.` in `docs/` was inside the broken `getErrorCode` claim, removed by F-1 |
| F-22 | Credential material in tracked files | — | **Already correct**: no API key, JWT, or key hex in any tracked file. `tools/install-capture/var/` and `node_modules/` are gitignored |

## 4. Cross-reference integrity

Checked by set-difference between the identifiers each defining document declares and every
identifier cited anywhere in the repository:

| Family | Defining document | Result |
|---|---|---|
| `UT-`, `CT-`, `IT-`, `LV-`, `DS-` | docs/13 | all resolve; no orphans |
| `P-*` | docs/07 §3 | all resolve (`P-CF`, `P-PROJ`, `P-TAG`, `P-TASK` appear only as family references) |
| `F*`, `N*` | docs/02 | all resolve |
| `W*`, `R*`, `S*` | docs/01 | all resolve |
| `L*`, `E*` | evidence/webhook-validation.md §3 | all resolve |
| `IC-*` | evidence/install-capture-2026-08-08.md | all resolve |
| `A*`, `B*` | evidence/live-probes-2026-08-08-round2.md | all resolve |

Three identifiers were added by this pass and are defined where they are used: `IT-14`,
`DS-01…DS-03` (both docs/13) and `FP-1…FP-4` (this file). Every `docs/11` row now cites a test in
docs/13 or states why none is needed. The ten ADRs still match the documents that cite them; none
needed a revision, because no decision changed — F-1 and F-3 correct *how* a decided rule is
implemented, not the rule.

## 5. Honesty of remaining unknowns

| Unknown | Owner |
|---|---|
| Addon-token success path on production | LV-04 (PROVED on the developer environment, IC-4) |
| Addon-mode webhook delivery on production | LV-02 (PROVED on the developer environment, IC-5) |
| Component iframe load with a real viewer token | LV-01 |
| Custom-field item shape from a live workspace | LV-08 (R23; the dev workspace holds zero fields) |
| Required-CF-without-default rejection code | LV-08; any rejection maps to FAILED with its code (R15) |
| `onlyAdminsCanChangeBillableStatus` on the addon path | LV-07 |
| Populated approval fields in a deletion payload | Accepted, structurally unreachable — approved entries cannot be deleted (R9, A8) |
| Locked-period date semantics | Accepted — locks are UI-only (R20); P-LOCK-REG never parses dates |
| Create-for-user for an inactive owner | Accepted — P-OWNER blocks first (docs/11) |
| Missed deletions during prolonged addon downtime | Accepted risk (webhook-validation §4) |

## 6. Independent-review status

The gateway's OpenAI provider auth was still broken on 2026-08-08
(`openai isn't accepting your saved login`), so no DeepSeek pass ran. Every claim in this file
rests on direct SDK source inspection or on a live probe recorded above, and the headline finding
(F-1) was independently reviewed by the harness advisor before any edit was made.

## Reproduction

The two probe scripts were temporary and are not committed — they would have to carry a live
installation to be useful, and `tools/install-capture/probe-addon-token.mjs` already covers the
credential handling. To repeat FP-1…FP-4, install the capture server (see
`install-capture-2026-08-08.md` §Reproduction), then call `workspaces.get`,
`customFields.listForWorkspace({ "entity-type": ["TIMEENTRY"] })`, and a `createForUser` with no
`projectId`, printing `typeof err.body.code` and `getErrorCode(err)` for each rejection.
