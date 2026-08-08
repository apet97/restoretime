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

# Live run 7 — the first authenticated component render, and the defect it found

Every earlier run exercised the server through HTTP. This one loaded the addon in a real Clockify
iframe on the developer environment, which is what docs/15 step 6 asks for and what docs/16 twice
recorded as unverified.

## The defect: the component could not load data in any browser

The shell rendered and then showed "RestoreTime could not complete that request." The cause was the
component response's own CSP:

```
default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors <parent>; script-src 'self'
```

`src/ui/api.ts` reaches `/api/*` with `fetch`, which is governed by `connect-src`. That directive was
absent, so it fell back to `default-src 'none'` and the browser blocked every call. Captured from the
page itself via a `securitypolicyviolation` listener:

```
violatedDirective: "connect-src"
effectiveDirective: "connect-src"
blockedURI:         <addon base>/api/entries?scope=mine
```

A same-origin `fetch` that `curl` served fine threw `TypeError: Failed to fetch`; the UI's generic
catch turned that into the message above.

This shipped in rc.1 through rc.5. **No offline test could have caught it**: `tests/e2e/` injects a
stub `fetch`, and happy-dom does not enforce CSP. It is the same failure mode as the earlier
`script-src` omission — `default-src 'none'` denies one directive at a time, and only a real browser
says which.

Fix: `connect-src 'self'` added alongside `script-src` in `src/server.ts`. Pinned by
`tests/unit/server.test.ts`, which was confirmed to fail with the directive removed and pass with it
restored — the assertion bites rather than merely existing.

## What the render then proved, in the real iframe

Walked with the addon embedded at `https://developer.clockify.me/addons/restoretime`, signed in as an
OWNER, against an entry owned by a *different* user:

```
list       ->  "Deleted time entries" with filters, bulk mode, and rows in three real states
               (Blocked / Needs your input / Ready to recreate)
detail     ->  deleted-vs-planned comparison, Differences, "Continue to confirm"
confirm    ->  "Fidelity: Complete", "Recreate entry"
recreate   ->  metric:recreate_attempt -> metric:recreate_success
success    ->  "Time entry recreated." + "Open in Clockify tracker"
```

Clockify itself then displayed a native toast, **"Add-on: Time entry recreated."** That is the parent
frame reacting to our `postMessage` bridge, so the bridge is verified live. A top-level page load
cannot show this — `window.parent === window` there — which is also why the 401-refresh path must not
be claimed from a top-level load.

No CSP violation appeared anywhere in the walk, and every request in the flow succeeded. A completed
pass is a stronger check than enumerating directives by hand: any other missing directive would have
broken one of these calls.

The recreated entry was deleted afterwards (HTTP 204). The component token used for diagnosis was a
short-lived Clockify-signed JWT held only in the scratchpad; no credential entered this repository.

## What is still not verified

Production (`app.clockify.me`) has still never been exercised — this run was entirely on the
developer environment, per the operator's instruction.

# Live run 8 — workspace settings toggled in the UI; a second real defect

R20 proved these settings cannot be changed through the API, so the rules that read them had never
seen a non-default value. Browser access to the developer workspace removed that blocker. Each
setting was toggled in the Clockify UI, read back through the API, and reverted; the workspace was
confirmed byte-for-byte back at baseline afterwards.

## The defect: an unlocked workspace looked locked

Baseline read of the workspace, before touching anything:

```
timeTrackingMode: "DEFAULT"   lockTimeEntries: null   automaticLock: null
```

`automaticLock` is an explicit `null` when no automatic lock is configured — not an absent field. The
mapping in `src/clockify/preflight-data.ts` computed:

```
automaticLockSet: settings?.automaticLock !== undefined
```

and `null !== undefined` is `true`. So `lockConfigured` was true on every workspace with no lock at
all, and P-LOCK-REG warned every regular user that "the entry's date may be in a locked period" on
any entry 24 hours or older. docs/07 §3 requires the setting to be *set*.

Fixed to `(settings?.automaticLock ?? null) !== null`, pinned by
`tests/integration/lock-settings.test.ts`, which was confirmed to fail against the old expression.

The unit preflight tests could not have caught it: they construct `WorkspaceState` directly, so they
start from `automaticLockSet` already decided. The defect lived in the API mapping — the same layer,
and the same class of assumption, as the R24 project-gone defect.

## Real shapes, now recorded rather than assumed

With "Automatically update lock date" switched on, Clockify returns:

```json
{"type":"WEEKLY","changeDay":"WEDNESDAY","firstDay":"MONDAY","dayOfMonth":1,
 "olderThanPeriod":"DAYS","olderThanValue":1}
```

That object is what the regression test now uses. "Lock time before" is mutually exclusive with the
automatic lock in the UI and could not be set while it was on, so a non-null `lockTimeEntries` string
remains unobserved; the rule only tests it for `!== null`, which is shape-independent.

## P-TIMER's input is real, and the admin carve-out is right

With "Disable adding and editing time manually" switched on, the API reports
`timeTrackingMode: "STOPWATCH_ONLY"` — exactly the literal the app's type expects.

A completed entry created by the workspace OWNER while that setting was active returned **HTTP 201**,
not a rejection. So Clockify exempts admins from the timer requirement, which is what P-TIMER already
assumed with its `!isAdmin(viewer)` condition. The rule matches the platform.

The probe entry was deleted (HTTP 204). Every setting was returned to baseline:
`timeTrackingMode: "DEFAULT"`, `lockTimeEntries: null`, `automaticLock: null`, `forceProjects: true`.

# Live run 9 — a full UI/UX sweep in the real iframe, and what it found

The CSP fix (Live run 7) made the component usable for the first time, so this run walked every
view an operator can reach, in the real Clockify iframe on the developer environment.

## What already worked, confirmed by walking it

```
ACTION_REQUIRED   P-CF-OPT widget offered the current options plus "Keep the original value" /
                  "Drop this value"; "Continue to confirm" stayed disabled until a choice was made;
                  choosing re-ran preflight, cleared the region, and the confirm view reported
                  Fidelity: Adjusted. The chosen "Option 2" was written verbatim to that exact
                  custom field on the new Clockify entry.
Blocked entry     detail showed "This entry cannot be recreated yet" with the real P-TYPE reason,
                  and "Continue to confirm" was disabled — no dead action.
Filters           search 127 -> 12 matching rows; status=Recreated returned only recreated rows,
                  which correctly carry no Recreate button.
Bulk              select -> review -> "Recreate 2 entries" -> both RECREATED.
Escaping          a description carrying quotes, &, backtick, ${tpl} and unicode rendered literally;
                  nothing executed. Clockify itself rejects < and > in descriptions
                  (400 {"message":"You entered wrong value. Don't use \"<\" and \">\" characters",
                  "code":501}), but the UI does not rely on that: src/ui/dom.ts builds every node
                  with createTextNode, and there is no innerHTML in src/ui/.
```

## Defects the sweep found

**Dismiss had no user interface at all.** `POST /api/entries/dismiss` existed and worked, but
nothing in `src/ui/` ever called it — only `undismiss` was wired. docs/06 specifies
IDLE/FAILED → DISMISSED, so the state was unreachable through the product: the "Show dismissed"
toggle could never show anything, and a list could only ever grow. Added the action to the detail
view beside "Continue to confirm", where the inverse already lived. Now proven live: dismiss → the
entry leaves the default list → "Show dismissed" reveals exactly it, "Status: Dismissed" →
undismiss → back. `tests/integration/dismiss-roundtrip.test.ts` pins the contract, which nothing
covered before (only a 403 path and one auth loop touched the endpoint).

**The list was unbounded.** `entries.list` had no `LIMIT`, and `handleListEntries` runs a full
preflight — with its own Clockify project/task lookups — for every actionable row returned. The test
workspace reached 127 rows within a day, all rendered and all preflighted on every list render. Now
bounded to 50 with the page and a `truncated` flag returned by the server, and a notice in the UI.
The performance test now asserts the bound instead of asserting 5000 rows come back.

**The bulk review view could not be reviewed.** A "ready" row carries no reason text, so rows
rendered as a bare "Ready — ": several identical lines an admin was asked to confirm blind. The
route now returns each row's `source`, and the view shows the entry header and description. Its
checkboxes also had no accessible name; they now say which entry they toggle. The results view
reported the raw 24-character Clockify id ("New entry 6a777ab2cf..."), which told the reader
nothing — the "Open" button beside it is what reaches the entry.

**There was no styling at all.** The component rendered in browser defaults — Times New Roman
headings, unstyled controls — inside Clockify's own interface, and the verified `theme` claim was
applied to an attribute no rule consumed, so a dark-mode user would get a white panel. Added
`/static/app.css` with `style-src 'self'` (the third directive this project has had to add past
`default-src 'none'`), custom-property colours, and a dark palette.

Two CSS mistakes worth recording, both from styling against the accessibility tree instead of the
DOM: `li > button:first-of-type` matched nothing (every row child is its own `<div>`), so the row's
date header picked up the primary-button rule and rendered as a filled blue button; and a generic
`section` rule painted the routine "Differences" block in warning orange. Both are now explicit
classes the views set — `rt-primary`, `rt-title`, `rt-notice` — rather than positional guesses.

## Not verified

`DARK` has never been observed arriving from Clockify: the developer environment exposes no
dark-mode setting to turn on. The dark palette keys off the attribute the SDK's `applyClockifyTheme`
writes, and `tests/e2e/component-flow.test.ts` proves the chain claim → shell `data-theme` → root
`data-clockify-theme="dark"`; whether Clockify ever sends that claim value is untested.

The 401 token-refresh path (docs/10 §8) still has no live proof — it needs a component session left
open past the 25-minute proactive refresh.

# Live run 10 — the whole installation lifecycle, driven end to end

Everything below was done through the Clockify UI on the developer workspace, watching the addon's
own log and database. No step needed the operator.

```
STATUS_CHANGED -> INACTIVE   "installation status changed" ... status INACTIVE   (persisted)
STATUS_CHANGED -> ACTIVE     "installation status changed" ... status ACTIVE     (persisted)
DELETED                      "installation deleted" ... result "deleted"
INSTALLED (fresh)            "installation installed" ... addonId 6a778f5a…      (new id)
TIME_ENTRY_DELETED           webhook_received -> recoverable_created             (new token)
```

## F17 purge, proved on real data

Immediately before uninstalling, the live database held:

```
recoverable_entries 132   recreation_plans 11   recreation_attempts 4   installations 1
```

After Clockify's DELETED lifecycle call, every one of those tables read **0**. This is the strongest
form of the IT-11 claim available — a real uninstall of a real installation purging real rows,
rather than an integration test's synthetic fixture.

## What disabling actually does, and what it means for docs/10 §8

Clockify's own confirmation says: "When you disable this add-on it will disappear from Clockify
interface and the add-on will lose access to your workspace." That is literally true — while
INACTIVE, `/addons/restoretime` **redirects to `/tracker`** and the sidebar entry is removed.

So docs/10 §8's disabled-state notice ("RestoreTime is disabled for this workspace" replaces
actions, lists stay readable) is not something a user reaches by navigating: the platform removes
the entry point first. The notice is still correct and still worth keeping — an iframe already open
when the status changes keeps running — and the server-side `actionGuard` refusal remains the real
protection, because that stale iframe can still POST. What is wrong is any expectation that a user
will *see* the notice; recorded here rather than left as an implied claim.

## Reinstall, and the suite re-run

Reinstalled from the addons page by pasting the manifest URL — the same "Insert link" + Install flow
an operator uses, so this whole cycle is reversible without operator involvement. The fresh install
rendered the docs/10 §1 **empty state** ("No deleted time entries. When you delete a time entry in
Clockify, it appears here."), which no earlier run had ever seen because the workspace always had
rows.

The live suite then ran against the fresh installation on the current build: **11 passed, 0
skipped**, including LV-07 re-confirming R12 (`onlyAdminsCanChangeBillableStatus=false`,
`defaultBillableProjects=true`, P-BILL fires for a regular viewer).

## Workspace left as found

No `RT-PROBE` time entries remain in Clockify. Workspace settings are at baseline
(`timeTrackingMode: DEFAULT`, `lockTimeEntries: null`, `automaticLock: null`, `forceProjects: true`).
The addon is installed and ACTIVE.

# Live run 11 — the purge is delivery-dependent (found by an outage, not a test)

The session's cloudflared quick tunnel exited, and its hostname cannot be recovered — a quick tunnel
gets a new random name each start. The addon installed in the developer workspace was therefore
pointing at a dead URL, so a fresh tunnel was started and the installation re-pointed:

```
new tunnel      https://consideration-automatically-…trycloudflare.com   /healthz 200, /manifest 200
uninstall       confirmed in the Clockify UI
                -> NO "installation deleted" line arrived
install         "installation installed" ... addonId 6a779984…            (new id, new URL)
component       renders again, 12 rows
```

## What the missing log line means

Clockify sends the `DELETED` lifecycle to the URL registered **at install time**. That URL was the
dead tunnel, so the call never reached this process. Checked straight afterwards:

```
Clockify:   add-on removed from the workspace
this addon: installations 1 (addonId 6a778f5a…, ACTIVE), recoverable_entries 12
```

The two disagreed, and nothing reconciles them — there is no periodic check that an installation
still exists. So **F17's purge is delivery-dependent**: it is exact when the call arrives (Live run
10 took 132 rows to zero), and it simply does not happen when the host is unreachable at that
moment.

This matters because `implementation/marketplace/privacy-policy.md` told users deletion happens
"in one operation, immediately". That claim is only true for a reachable host. The privacy text and
docs/08 now carry the qualification instead of implying a guarantee the delivery model cannot make.
No code changed: a reconciliation pass would be the fix, and v1 does not have one.

Worth noting how this surfaced — an infrastructure outage during cleanup, not a test. The suite
cannot see it, because every test delivers the lifecycle call it is asserting on.
