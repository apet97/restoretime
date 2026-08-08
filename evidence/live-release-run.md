# Live release run — PASS-05 (sanitized)

What was actually verified during PASS-05, and, plainly, what could not be. No credential or token
appears in this file — every other value below is a throwaway generated on this machine, an image
ID, a status code, or the sacrificial workspace id, which the blueprint already records elsewhere
in `evidence/`.

## 1. What could not run, and why

`CK_LIVE_API_KEY` was not present in this environment when PASS-05 ran. I verified this myself
before starting any implementation work (per the pass brief):

- `GET https://api.clockify.me/api/v1/workspaces/65b382b606de527a7ee2b60e` with the
  developer-environment API key → `401 {"message":"Api key does not exist","code":4003}`; `/user`
  gives the same. `developer.clockify.me` and `api.clockify.me` are separate credential realms —
  the developer-environment key does not authenticate against production.
- No production personal API key for the sacrificial workspace was supplied to this environment.

**Consequence**: `tests/live/*` (LV-01…LV-10) could not execute their real-network paths. Every LV
test file ran and reported **blocked — no valid live installation (missing CK_LIVE_API_KEY)** (or,
for LV-01/LV-02, the additional `CK_LIVE_ADDON_BASE_URL`) — see §3. `npm run test:live` exits 0 in
this state, which is **not** the release gate passing; docs/16's live-suite box stays unchecked.

## 2. What DID run for real, and what it proved

### 2.1 A deliberately-wrong credential — proving the honest-failure path is real, not aspirational

To confirm the "blocked" path is not the *only* path the suite can take — that a present-but-wrong
credential produces a real failure, not a silent pass — I ran the suite with a syntactically valid
but fake API key against the real production host:

```text
$ CK_LIVE_API_KEY=fake-invalid-key CK_LIVE_WS=000000000000000000000000 npx vitest run tests/live/lv-07-billable-permission.test.ts
LV-07 Clockify rejected CK_LIVE_API_KEY as an addon token (401 code 4017) — this is a real R11 finding, not a suite defect.
 ❯ tests/live/lv-07-billable-permission.test.ts (1 test | 1 failed)
UnauthorizedError: UnauthorizedError
Status code: 401
Body: { "message": "Token is not valid", "code": 4017 }
 Test Files  1 failed (1)
      Tests  1 failed (1)
```

Same result for `lv-05-missing-project-archived-tag.test.ts`. This is real, unmocked traffic to
`https://api.clockify.me/api` — reachable, TLS-terminated, and it rejected the fake key exactly the
way the SDK's own error classification predicts (`ClockifyApiError`, `statusCode 401`,
`code "4017"`). It is real evidence the transport, the SDK client construction, and this suite's
error-reporting path all work end to end; it is **not** evidence about R11 itself (a wrong key
proves nothing about whether a *real* key/addon-token works) and is not treated as such anywhere in
this repository.

### 2.2 Docker image build and boot (real, local, arm64)

Built from the repository root with the committed `Dockerfile`:

```text
$ docker build -t restoretime:pass05-a -f Dockerfile .
...
Successfully built 694b2822184f
Successfully tagged restoretime:pass05-a

$ docker image inspect restoretime:pass05-a --format '{{.Id}}'
sha256:694b2822184f5788571103d74d7878f02bcd9010c68eb34c68d011100dbe2c4c

$ docker image inspect restoretime:pass05-a --format '{{.Architecture}}/{{.Os}}'
arm64/linux
```

This is a local build on a Colima VM on Apple Silicon — the digest above is an **arm64** image, not
the x86_64 artifact a typical cloud VM would run. A production build on x86_64 infrastructure needs
its own `docker build` (this Dockerfile has no architecture-specific step; it should produce an
equivalent x86_64 image the same way — better-sqlite3's prebuild-install fetched a matching native
binary automatically for this build without any Dockerfile change).

Run with a throwaway 64-hex `TOKEN_ENCRYPTION_KEY` on the command line (never a file) and a named
Docker volume for `/data`:

```text
$ docker run -d --name restoretime-pass05-a -p 18080:8080 \
    -e PORT=8080 -e PUBLIC_BASE_URL=https://addon.example.invalid \
    -e CLOCKIFY_PARENT_ORIGIN=https://app.clockify.me \
    -e DATABASE_PATH=/data/restoretime.sqlite -e ADDON_KEY=restoretime-docker-check \
    -e TOKEN_ENCRYPTION_KEY=<throwaway 64 hex chars> -e LOG_LEVEL=info \
    -v restoretime-pass05-data:/data restoretime:pass05-a

$ docker logs restoretime-pass05-a
{"time":"2026-08-08T10:31:23.270Z","level":"info","msg":"listening","port":8080,"baseUrl":"https://addon.example.invalid"}

$ curl -sS -i http://127.0.0.1:18080/healthz
HTTP/1.1 200 OK
content-type: application/json
Content-Length: 25

{"status":"ok","db":"ok"}

$ curl -sS -o /dev/null -w "manifest status: %{http_code}\n" http://127.0.0.1:18080/manifest
manifest status: 200
$ curl -sS -o /dev/null -w "icon status: %{http_code}\n" http://127.0.0.1:18080/icon.svg
icon status: 200
$ curl -sS -o /dev/null -w "component (no token) status: %{http_code}\n" http://127.0.0.1:18080/component
component (no token) status: 401

$ docker inspect --format '{{.State.Health.Status}}' restoretime-pass05-a
healthy
```

First-boot migrations ran automatically (docs/14 "Migrations"): `user_version` reached `2`
(`0001_init.sql`, `0002_recovery.sql`) with no operator action.

### 2.3 Rollback drill (real, local, executed in full — docs/15 "Rollback")

Full transcript and design rationale: `implementation/reports/PASS-05.md` §Rollback drill. Summary:

1. Image A (`restoretime:pass05-a`, §2.2) ran and migrated a fresh volume to `user_version=2`.
   Checkpointed (`PRAGMA wal_checkpoint(TRUNCATE)`) and backed up to a file outside the volume.
2. A **drill-only** migration (`0003_drill_rename.sql`, renaming
   `recoverable_entries.owner_id` → `owner_user_id` — never added to `src/store/migrations/` in
   this repository; it exists only in a temporary, separate build context) was built into a second
   image, `restoretime:pass05-b-drill`, and run against the SAME live volume.
3. It booted, auto-applied the migration to `user_version=3`, and **`/healthz` still reported
   `200 {"status":"ok","db":"ok"}`** — `src/store/db.ts`'s `migrate()` never rejects an older image
   opening a database a newer image already migrated, and `/healthz`'s `SELECT 1` cannot see a
   column rename at all. This was checked deliberately, not assumed: it is why the drill needed a
   second, independent observable.
4. That second observable: image A's own query shape
   (`SELECT id FROM recoverable_entries WHERE workspace_id = ? AND owner_id = ?`, copied verbatim
   from `src/store/entries.ts`) run directly against the post-migration file failed with
   `Error: no such column: owner_id` — concrete proof that reusing image A against
   image B's migrated data (skipping rollback) breaks real routes even though `/healthz` alone
   would not have caught it.
5. Rollback executed: image B stopped; the pre-migration backup restored over the live volume
   (stale `-wal`/`-shm` files removed first); image A started again on the restored volume.
6. Post-rollback: `/healthz` → `200 {"status":"ok","db":"ok"}`; `user_version` back to `2`; the
   `owner_id` query succeeded again; `/manifest`, `/icon.svg`, `/static/app.js` → `200`;
   `/component` (no token) → `401` (the verified-claims boundary intact); Docker `HEALTHCHECK` →
   `healthy`.

This exercised the exact sequence docs/15 §Rollback specifies (stop current → restore backup →
start previous → verify healthz + one component load), against a real, deliberately-broken
migration, not a no-op drill.

## 3. LV-01…LV-10 — exact reported state with no credentials

Every row ran (not skipped — `--passWithNoTests` was removed from `test:live` in this pass) and
reported blocked by name:

```text
$ npm run test:live
LV-01 blocked — no valid live installation (missing CK_LIVE_API_KEY)
LV-02 blocked — no valid live installation (missing CK_LIVE_API_KEY)
LV-03 blocked — no valid live installation (missing CK_LIVE_API_KEY)
LV-04 blocked — no valid live installation (missing CK_LIVE_API_KEY)
LV-05 blocked — no valid live installation (missing CK_LIVE_API_KEY)
LV-07 blocked — no valid live installation (missing CK_LIVE_API_KEY)
LV-08 blocked — no valid live installation (missing CK_LIVE_API_KEY)
LV-09 blocked — no valid live installation (missing CK_LIVE_API_KEY)
LV-10(a) blocked — no valid live installation (missing CK_LIVE_API_KEY)
LV-10(b) blocked — no valid live installation (missing CK_LIVE_API_KEY)

 Test Files  10 passed (10)
      Tests  11 passed (11)
```

(LV-06 has no file — struck through in docs/13, merged into LV-05. The 10th passing file,
`tests/live/support.test.ts`, is a credential-free mechanism proof for the LV-09 recording-fetch
helper, not an LV row — see §4.) With `CK_LIVE_API_KEY` and
`CK_LIVE_WS` set but `CK_LIVE_ADDON_BASE_URL` absent, LV-01/LV-02 report the more specific reason:

```text
LV-01 blocked — no valid live installation (missing CK_LIVE_ADDON_BASE_URL: the public base URL of
a RestoreTime instance already deployed and already installed on the sacrificial workspace)
```

A passing `npm run test:live` in this state is **not** the docs/16 release gate — it is the honest
"nothing ran" report the pass brief required instead of a silent `--passWithNoTests` pass. See
`implementation/reports/PASS-05.md` for the row-by-row status and exactly what each row will
exercise once credentials (and, for LV-01/LV-02, a deployed host) exist.

## 4. LV-10's offline proof (the hard gate's mechanism, proved without credentials)

LV-10 is a hard release gate (pass file: "if the chaos hook cannot run in the deployment shape, the
release stops"). The `RT_CHAOS_FETCH` hook (`src/clockify/chaos-fetch.ts`) is proved against a
mocked transport in `tests/integration/chaos-fetch-drill.test.ts` (7 tests, all passing on this
commit): both modes (`lose-response`, `fail-before-send`) correctly drive `attemptRecreation`/
`runReconcile` to the documented AMBIGUOUS → RECREATED / AMBIGUOUS → IDLE outcomes, the hook only
ever intercepts the `createForUser` POST (never a GET), and the hook is provably inert whenever
`NODE_ENV !== "test"` regardless of the flag's value. This is what "the mechanism itself works" can
mean without a live credential; `tests/live/lv-10-ambiguity-drill.test.ts` repeats both legs against
the real sacrificial workspace once one exists.

The same "prove the mechanism offline first" standard applies to LV-09's `recordingPassthroughFetch`
helper: `tests/live/support.test.ts` (credential-free, always runs) drives one real request through
the wrapper once installed as `globalThis.fetch` and asserts it forwards correctly instead of
recursing into itself — a real bug this exact check caught during review before this pass landed
(see `implementation/reports/PASS-05.md` §9).

## 5. Operator inputs still required (full list)

See `implementation/reports/PASS-05.md` §Operator inputs for the complete, current list.

---

# Live run 2 — 2026-08-08, developer environment, real installed addon

The first PASS-05 run could not reach any live row. This one did. The operator supplied credentials
and installed the addon, and the target environment is `developer.clockify.me` (their direction —
it is also where DS-01…DS-03 already run).

## Result: LV-01…LV-10 pass; LV-08 skips for a platform reason

```
$ npm run test:live
 Test Files  10 passed (10)
      Tests  10 passed | 1 skipped (11)
```

Reproduced twice with identical results.

| Row | Result | What it proved live |
|---|---|---|
| LV-01 | pass | manifest, icon and bundle served from the deployed host; `/component` refuses an unverified caller |
| LV-02 | pass | a real delete fired `TIME_ENTRY_DELETED` — **and the deployed addon received and persisted it** (below) |
| LV-03 | pass | plan → confirm → RECREATED end to end against real Clockify. Partial: no usable custom field, so the R5 assertion did not run |
| LV-04 | pass | **R11 closed on the real addon path** — an admin recreated another user's entry using the installation's own addon token |
| LV-05 | pass | P-PROJ-GONE and P-TAG-ARCH both surfaced; supplying choices produced a real recreated entry |
| LV-07 | pass | **R12 closed** — `onlyAdminsCanChangeBillableStatus=false`, `defaultBillableProjects=true`; P-BILL fired for a regular viewer exactly as the rule says |
| LV-09 | pass | description-filtered `listForUser` reflects a fresh create immediately; the fingerprint round-trips against a real fetched entry; a running entry shows `end:null` unfiltered; **no windowed query is ever sent** (R10) |
| LV-10 (a) | pass | **the hard gate.** With `RT_CHAOS_FETCH=lose-response` the create really committed at Clockify while the caller saw a transport failure → AMBIGUOUS → reconcile adopted it → RECREATED |
| LV-10 (b) | pass | nothing sent → AMBIGUOUS → bounded reconcile found nothing → "not created" → IDLE |
| LV-08 | **skipped** | see below |

## Webhook receipt, confirmed from the addon's own logs

LV-02 states it cannot confirm receipt. The operator can, and did — the deployed instance logged a
matched pair for every probe delete:

```
{"msg":"metric:webhook_received",    "workspaceId":"69bda6b317a0c5babe34b4ff"}
{"msg":"metric:recoverable_created", "workspaceId":"69bda6b317a0c5babe34b4ff"}
```

Sixteen pairs, and 14 rows persisted in `recoverable_entries`. Delete in Clockify → RS256-verified
delivery → normalized row. W11 and the ingestion path are proved end to end on a real installation.

## New live findings

1. **A custom field created through `customFields.createForWorkspace` arrives `status: "INACTIVE"`.**
   Probed directly: create returns 201 with `status: "INACTIVE"`, and both the API key and the addon
   token then list it as INACTIVE. The app is right to ignore it (S6: active means
   `status !== "INACTIVE"`), so no P-CF-* rule fires for a freshly created field.
2. **Activating it is not possible here.** `customFields.updateForWorkspace` with
   `status: "VISIBLE"` answers **500** on this workspace. LV-08 therefore cannot stage its scenario
   at all and reports a skip naming the exact status. Nothing in that setup exercises product code,
   so this is a workspace/plan-shape gap — not a suite or product defect. **R23's custom-field
   item-shape question stays open.**
3. **The live suite must run sequentially.** With ten files in parallel against one workspace the
   results were flaky — different rows failed on each run, all with real Clockify errors. Serialised
   (`--no-file-parallelism`) it is stable across repeated runs. The failures were the suite racing
   itself, never the product.

## Suite defects this run exposed and fixed

- `buildLiveRestClient` passed the API key through the app's client factory, which always sends
  `X-Addon-Token`. Clockify answered `401 code 4017`, and the test then claimed "a real R11 finding,
  not a suite defect" — blaming the platform for our own wiring. The probe client now uses the SDK's
  `apiKey` mode, and the 401 message distinguishes `4003` (bad API key) from `4017` (bad addon
  token).
- The app-driving rows accepted an API key as the installation token. They now require a real
  `CK_LIVE_ADDON_TOKEN` and report blocked without it — otherwise LV-04 could look green while
  proving nothing about R11, which is the one thing it exists to prove.
- Probe fixtures created entries with no project on a `forceProjects` workspace, so Clockify
  rejected them with `400 code 501` (R4). Fixtures now attach a real project, which is also what a
  genuine deleted entry there looks like.
- LV-09's planned request omitted `projectId` while its probe entry had one, so `fingerprintMatches`
  correctly reported a mismatch. The fixture now describes the entry it actually created.

## Cleanup

A post-run sweep of every workspace member's entries, the workspace's custom fields, and its tags
found **zero** remaining `RT-PROBE-` artefacts.

## What is still not verified

- **Production (`app.clockify.me`).** Everything above is the developer environment. The production
  sacrificial workspace has never been exercised.
- **An authenticated component render.** Only Clockify's platform key can sign a real component
  session, so LV-01 proves the boundary rejects unverified callers, not that a signed load renders.
  That stays the docs/15 step-6 production smoke.
- **R23's custom-field item shape**, blocked by finding 2 above.

---

# Live run 3 — 2026-08-08, operator-provisioned custom field

The operator added one TIMEENTRY custom field to the workspace: `asdadsdad`, type `TXT`,
`status: VISIBLE` (so active per S6), `required: false`, no `workspaceDefaultValue`.

## R5 is now closed live

LV-03 no longer reports PARTIAL. Its custom-field assertion ran and passed: a value differing from
the field's default was sent in the `customFields` key at create, and the value came back on the
recreated entry. That is R5 proved end to end on a real workspace through the addon path — not a
fixture.

```
$ npm run test:live
 Test Files  10 passed (10)
      Tests  10 passed | 1 skipped (11)
```

## LV-08 still skips, and now says exactly what it needs

LV-08 was changed to prefer custom fields the workspace **already** has, the way LV-03 does, instead
of insisting on creating its own — creation cannot work here (fields arrive `INACTIVE` and
activation answers 500). It looks for two shapes and finds neither:

| Needed | Why | Present? |
|---|---|---|
| A `DROPDOWN_SINGLE` field with at least one allowed value | The source carries a value that is no longer in `allowedValues`, which is what makes P-CF-OPT fire | no |
| A field with `required: true` and **no** `workspaceDefaultValue` | A required field with nothing to fall back to is what makes P-CF-REQ fire (docs/07 §3) | no |

The one provided field is `TXT`, optional, so it matches neither. With both shapes present the row
runs and R23's custom-field item shape closes.

Teardown was tightened at the same time: the row now deletes only fields it created itself, tracked
explicitly. Deleting an operator's own workspace configuration would be the opposite of "leave the
workspace as you found it".

## Wording corrected

Several live files claimed they ran against "real production Clockify". They run against whichever
environment `CK_LIVE_API_BASE` names — production by default, the developer environment here. The
headers now say that instead of overstating which environment was exercised.

---

# Live run 4 — 2026-08-08, R23 closed

The operator added two dropdown fields, so the workspace now holds three active TIMEENTRY custom
fields. Every LV row runs; nothing is skipped.

```
$ npm run test:live
 Test Files  10 passed (10)
      Tests  11 passed (11)
```

## R23 is closed

R23's open half was the custom-field **item shape**: `type`, `allowedValues`, `required`, `status`,
`workspaceDefaultValue` were SDK-typed only, because the workspace held no custom fields. Live
items now exist and carry all five, deserializing into the SDK model the preflight reads:

| Field | type | status | required | allowedValues | workspaceDefaultValue |
|---|---|---|---|---|---|
| `asdadsdad` | `TXT` | `VISIBLE` | `false` | `[]` | `null` |
| `asdasadadas` | `DROPDOWN_SINGLE` | `VISIBLE` | `false` | `["Option 1","Option 2"]` | `null` |
| `asdasd` | `DROPDOWN_SINGLE` | `VISIBLE` | `false` | `["Option 1","Option 2","Option 3"]` | `"Option 2"` |

This also confirms the S6 facts in place: the status enum uses `VISIBLE` (there is no `"ACTIVE"`),
and the default lives on `workspaceDefaultValue`, not `defaultValue`.

## P-CF-OPT proved live (R19)

LV-08 now uses the workspace's own dropdown rather than creating one. The seeded deleted entry
carries a value that is **not** among the field's current `allowedValues`; preflight raised
`P-CF-OPT` against that exact field id; the user's "keep the original value" choice was applied; and
the recreated entry came back carrying that value verbatim.

That is R19 confirmed end to end on a real workspace: Clockify stores a dropdown value outside
`allowedValues` without complaint, so only preflight can surface the problem — and the product
surfaces it and preserves the user's decision.

## What remains open

**The P-CF-REQ half of LV-08.** All three fields have `required: false`, so no field forces the
"required with nothing to fall back to" case (docs/07 §3). LV-08 reports `PARTIAL` and names the
missing shape rather than passing silently. One active field with `required: true` and no default
value would close it.

R22's operator statement that a required custom field makes a value mandatory at create therefore
remains operator-stated, not live-proved.

---

# Live run 5 — 2026-08-08, R22 proved live; whole suite green with nothing skipped

The operator set two custom fields to `required: true` with no default value. That completed both
LV-08 halves and, more importantly, turned R22 from an operator statement into live evidence.

```
$ npm run test:live
 Test Files  10 passed (10)
      Tests  11 passed (11)      # no skips, no PARTIAL
```

## R22 is proved

R22(a) said "a required custom field makes a value mandatory at create time", on the operator's
word. Probed directly against the workspace, with two active required fields carrying no default:

```
create WITHOUT values for them  ->  400 {"message":" asdadsdad, asdasadadas","code":501}
create WITH    values for them  ->  201, all three field values stored
```

Two details worth keeping:

- **The rejection body's message is nothing but the missing field names** — no sentence, no
  explanation. That is another reason classification keys on `statusCode` plus the body code and
  never on message text (R6, R15). The code is `501`, the same domain-validation code that already
  covers "project required" and "archived tag" (R15, R18), so the code alone cannot say which
  cause applies — only preflight's own lookups can, which is exactly how docs/07 is built.
- **The third field auto-attached its default** (`asdasd` → `"Option 2"`) without being sent,
  confirming the R5 auto-attach behaviour on a live create.

## P-CF-REQ proved end to end

With a required field that has no default and no source value, LV-08's second half now runs:
preflight raised `P-CF-REQ` against that exact field id, the user's typed value was accepted, and
the recreated entry came back carrying it. Together with the P-CF-OPT half from run 4, the whole
docs/07 §3 custom-field rule set is now live-verified.

## What this exposed in the suite, and the fix

Turning on required fields broke five rows at once — every one of them for the same real reason:
the probe fixtures created entries without values for the newly required fields, so Clockify
rejected them 400/501, and the seeded sources triggered a legitimate `P-CF-REQ` that made the
confirm refuse with 422.

The product was right every time. The fixtures were unrealistic: a real deleted entry on a
workspace with required fields always carried values for them. `requiredCustomFieldValues()` in
`tests/live/support.ts` now supplies them, for both the create shape and the `DeletedTimeEntry`
shape, and every affected row uses it.

That is the third time this pattern has appeared — `forceProjects`, then required custom fields.
The lesson is recorded here rather than re-learned: **live fixtures must be derived from the
workspace's actual settings, never assumed.**

## Evidence closed live across the whole run

**R5** · **R10** · **R11** · **R12** · **R19** · **R22** · **R23** · **W11**

## What is still not verified

- **Production (`app.clockify.me`)**. Everything here is the developer environment.
- **An authenticated component render** — only a Clockify-signed session produces one, so it stays
  the docs/15 step-6 production smoke.

The operator's three custom fields were left in place; the sweep removes only `RT-PROBE-` artefacts,
and found none.

---

# Live run 6 — R17: a real non-REGULAR deletion payload

R17 rested on "every captured webhook entry had `type:"REGULAR"`" plus an operator directive. The
blocker P-TYPE had therefore never seen a real non-REGULAR payload — the one input it keys on.

Probed with the API key: create a `BREAK` entry, read it back, delete it, then read what the addon
actually persisted from the delivery.

```
created with type BREAK ->  server says type = "BREAK"
read back               ->  type = "BREAK"
deleted                 ->  webhook delivered
persisted source_json   ->  type = "BREAK"
```

So a non-REGULAR deletion does fire `TIME_ENTRY_DELETED`, the payload does carry the distinguishing
`type`, and normalization preserves it. P-TYPE's input is real, not assumed; the rule itself stays
unit-covered by UT-P14.

The probe entry was deleted from Clockify. The persisted row remains in the local live database,
which is the throwaway store this run created.
