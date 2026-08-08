# Live release run — PASS-05 (sanitized)

What was actually verified during PASS-05, and, plainly, what could not be. No credential, token,
or workspace-identifying value appears in this file — every value below is a throwaway generated on
this machine, an image ID, or a status code.

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
