# PASS-05 — Release report

Status: **BLOCKED ON OPERATOR INPUT** (as designed — see the pass brief). Every part of this pass
that could be built and executed without a live production credential was built and executed for
real. The live suite (LV-01…LV-10) and the Marketplace submission cannot complete without operator
inputs this pass was explicitly told not to fabricate: `CK_LIVE_API_KEY`, a deployed host
(`CK_LIVE_ADDON_BASE_URL`), and Marketplace listing assets (icon artwork, screenshots, long
description).

## Repository / branch

Worktree: `/Users/15x/Downloads/WORKING/addons-me/restoretime/.claude/worktrees/agent-a7a15410491982c02`

Branch: `worktree-agent-a7a15410491982c02` (assigned by the harness; the pass file names
`pass-05-release` — not renamed mid-pass, same deviation PASS-04 recorded for the same reason).

## 1. Files created or changed this pass

```
Dockerfile                                          — new: 3-stage build (builder/deps/runtime),
                                                        node:22-bookworm-slim throughout, non-root
                                                        `node` user, /healthz wired, docs/05 env
                                                        table documented in comments
.dockerignore                                       — new

src/clockify/chaos-fetch.ts                          — new: RT_CHAOS_FETCH hook (LV-10), test-only,
                                                        gated on NODE_ENV==="test" like the existing
                                                        RT_TEST_CRASH_MID_ATTEMPT pattern
src/clockify/client.ts                                — wires the hook into buildClockifyClient;
                                                        byte-identical clientOptions when inactive
tests/integration/chaos-fetch-drill.test.ts          — new: 7 tests proving the hook mechanics
                                                        against a mocked transport (both modes, the
                                                        NODE_ENV guard, the createForUser-only
                                                        matcher)

tests/live/support.ts                                — new: shared live-suite harness (env gating,
                                                        in-process test-signed server + real
                                                        Clockify REST client, seeding helper)
tests/live/support.test.ts                           — new: credential-free proof that
                                                        recordingPassthroughFetch does not recurse
                                                        into itself once installed as globalThis.fetch
tests/live/lv-01-install-component.test.ts           — new
tests/live/lv-02-webhook-delivery.test.ts            — new
tests/live/lv-03-own-recreation.test.ts              — new
tests/live/lv-04-admin-recreates-other-user.test.ts  — new
tests/live/lv-05-missing-project-archived-tag.test.ts — new (LV-06 merged into this row, docs/13)
tests/live/lv-07-billable-permission.test.ts         — new
tests/live/lv-08-custom-field-lifecycle.test.ts      — new
tests/live/lv-09-reconcile-read-pinning.test.ts      — new
tests/live/lv-10-ambiguity-drill.test.ts             — new
package.json                                         — test:live: removed --passWithNoTests

implementation/marketplace/README.md                 — new
implementation/marketplace/manifest-review.md        — new
implementation/marketplace/scope-justification.md    — new
implementation/marketplace/privacy-policy.md         — new
implementation/marketplace/terminology-check.md      — new

evidence/live-release-run.md                         — new: sanitized live-run transcript

docs/13-testing.md                                   — Live suite section: CK_LIVE_ADDON_BASE_URL
                                                        documented; LV-10's two RT_CHAOS_FETCH
                                                        modes spelled out; LV-06 note
docs/15-release.md                                   — pipeline step 5: env var list including the
                                                        new host variable
docs/16-definition-of-done.md                        — every box set true/false with a reason
implementation/reports/PASS-05.md                    — this report
```

## 2. Gate commands run, in order, with real output

Node: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`; `node -v` → `v22.23.1`.

```
$ npm ci
added 105 packages, and audited 106 packages in 3s
found 0 vulnerabilities

$ npm run typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.ui.json && tsc -p tsconfig.e2e.json
(clean)

$ npm run lint
> tsc -p tsconfig.lint.json && tsc -p tsconfig.lint.ui.json && tsc -p tsconfig.lint.e2e.json
(clean)

$ npm run test
 Test Files  33 passed (33)
      Tests  299 passed (299)
   Duration  6.81s

$ npm run build
  dist/static/app.js  51.8kb
⚡ Done in 11ms

$ npm run test:e2e
 Test Files  3 passed (3)
      Tests  18 passed (18)
```

Gate order matches the brief exactly (`npm ci && npm run typecheck && npm run lint && npm run test
&& npm run build && npm run test:e2e` — build before e2e, since the last E2E test boots the built
`dist/static/app.js`).

Additive, non-gate suites, also run and green:

```
$ npm run test:live
 Test Files  10 passed (10)
      Tests  11 passed (11)
(every row reports "blocked — no valid live installation (missing CK_LIVE_API_KEY)", or the
CK_LIVE_ADDON_BASE_URL variant for LV-01/LV-02 — see §5)

$ npm run test:dev-smoke
 Test Files  3 passed (3)
      Tests  3 passed (3)
(blocked — this sandbox has no CK_DEV_* credentials either; additive, never a release gate)
```

Baseline before this pass's changes (re-verified at the start, same commands): 32 test files / 292
tests, typecheck/lint/build/e2e all clean — confirming PASS-05 started from a genuinely green
PASS-04 state, not one this pass had to first repair.

## 3. Docker build and run transcript

Full commands and real output: `evidence/live-release-run.md` §2.2. Summary:

- `docker build -t restoretime:pass05-a -f Dockerfile .` → `Successfully built 694b2822184f`
- Image ID: `sha256:694b2822184f5788571103d74d7878f02bcd9010c68eb34c68d011100dbe2c4c`
- Architecture: **arm64/linux** (Colima on Apple Silicon — not the x86_64 shape a typical cloud VM
  runs; the Dockerfile has no architecture-specific step, so an x86_64 build from the same
  Dockerfile should behave identically, but was not built or tested here — no such target exists
  in this environment).
- `docker run ...` with a throwaway 64-hex `TOKEN_ENCRYPTION_KEY` on the command line (never
  written to a file) and a named Docker volume for `/data`.
- `curl -sS -i http://127.0.0.1:18080/healthz` → `HTTP/1.1 200 OK`,
  `{"status":"ok","db":"ok"}`.
- `docker inspect --format '{{.State.Health.Status}}' restoretime-pass05-a` → `healthy`.
- Migrations ran automatically at first boot (`user_version` 0 → 2, `0001_init.sql` +
  `0002_recovery.sql`), no operator action.
- `/manifest`, `/icon.svg`, `/static/app.js` → `200`; `/component` (no token) → `401` (the
  verified-claims boundary is live and correctly rejecting an unauthenticated request, not open and
  not crashing).

## 4. Rollback drill transcript

Full transcript: `evidence/live-release-run.md` §2.3. This is a genuine drill, not a dry run — it
was designed to demonstrate a REAL incompatibility, checked deliberately:

1. **Image A** (`restoretime:pass05-a`) booted against a fresh named volume, migrated to
   `user_version=2`. Checkpointed (`PRAGMA wal_checkpoint(TRUNCATE)`) and copied out to a backup
   file.
2. **Investigated `src/store/db.ts`'s `migrate()` first**, per the risk the advisor flagged before
   I built the drill: it never rejects an older image opening a database a newer image already
   migrated — it just skips any migration whose version is `<=` the file's current `user_version`.
   That single fact determines what the drill can prove: `/healthz` alone (a bare `SELECT 1`)
   cannot detect a schema change, so the drill needed a second, real observable — not an assumption
   that skipping rollback would "obviously" break something.
3. Built a **drill-only** migration, `0003_drill_rename.sql`
   (`ALTER TABLE recoverable_entries RENAME COLUMN owner_id TO owner_user_id;`) — added ONLY to a
   temporary, separate build context (`/tmp/...-rollback-drill/build-b/`, since deleted). It was
   never added to `src/store/migrations/` in this repository. Built as a second image,
   `restoretime:pass05-b-drill`, from the same Dockerfile.
4. Ran image B against the SAME live volume image A had just migrated. It booted, auto-applied the
   drill migration (`user_version` 2 → 3), and **`/healthz` still returned
   `200 {"status":"ok","db":"ok"}`** — confirming the fact from step 2 empirically, not just by
   reading the source.
5. **The real observable**: image A's own query shape, copied verbatim from
   `src/store/entries.ts`'s `list()` (`SELECT id FROM recoverable_entries WHERE workspace_id = ?
   AND owner_id = ?`), run directly against the post-migration file with the host's `sqlite3` CLI
   → `Error: no such column: owner_id`. This is the concrete proof that reusing image A against
   image B's migrated data — the thing rollback exists to prevent — would break real routes
   (`GET /api/entries`, the webhook insert, etc.) even though the healthcheck alone says nothing is
   wrong.
6. **Rollback executed**: image B stopped and removed; the pre-migration backup restored over the
   live volume (stale `-wal`/`-shm` files from image B's run removed first, so image A opens a
   clean file); image A started again on the restored volume.
7. **Post-rollback verification**: `/healthz` → `200 {"status":"ok","db":"ok"}`;
   `user_version` back to `2`; the `owner_id` query direct against the file succeeded again;
   `/manifest`, `/icon.svg`, `/static/app.js` → `200`; `/component` (no token) → `401`; Docker
   `HEALTHCHECK` → `healthy`.

This matches docs/15 §Rollback's exact sequence (stop current → restore backup → start previous →
verify healthz + one component load). "One component load" here means the closest thing available
without a real Clockify session (see §5, LV-01): the component route's boundary responds correctly
(401, not a crash or an open door), plus every public asset route it depends on (icon, bundle,
manifest) serves. A fully authenticated component render needs a Clockify-signed session, which
this local drill — deliberately — does not fabricate.

## 5. LV-01…LV-10 — implementation status, row by row

All ten scenarios are implemented as real, complete test files (not stubs) across the nine files in `tests/live/` — LV-06 has no file of its own because docs/13 merges it into LV-05. None
of the code in `tests/live/` is a substitute for the real check it names — every row either (a)
drives real, unmocked HTTP against production Clockify, or (b) is explicit in its own file header
about the one thing it structurally cannot verify without a human/Clockify browser session, and
never claims to have verified it anyway.

Design note that applies to LV-03…LV-10 (see `tests/live/support.ts`'s header comment for the full
rationale): they boot the app's own `createServer()` in-process with a **test-signed platform key**
— the exact pattern every offline integration test in this repo already uses for the JWT-
verification boundary (installation, component auth). The one thing NOT faked in those rows is the
Clockify REST boundary: the installation's `authToken` is `CK_LIVE_API_KEY` and `apiUrl` is the
real production host, so every Clockify call the app makes goes out over the real network to the
real sacrificial workspace. This is legitimate, not a weaker substitute — it changes nothing about
what PASS-01…04 already proved for the platform-JWT boundary, and it is the only way to prove R11
(API-key/addon-token REST equivalence) and R10 (`listForUser` field coverage) live without also
requiring a fully deployed host for every row.

| Row | What it will exercise (once creds/host exist) | What it reports now, without credentials |
|---|---|---|
| **LV-01** | Real deployed instance: manifest, icon, UI bundle served; `/component` enforces verified claims. Requires `CK_LIVE_ADDON_BASE_URL` — a real Clockify-issued component session cannot be produced by the test-signed harness, so this row never uses it | `blocked — no valid live installation (missing CK_LIVE_API_KEY)`; with the key present but no host, `blocked — ... (missing CK_LIVE_ADDON_BASE_URL: ...)`. Explicit in its own file that a fully authenticated component load is out of this suite's reach regardless of credentials — that needs docs/15's separate "Production smoke" step |
| **LV-02** | Real delete via `CK_LIVE_API_KEY` (the trigger); the deployed host receiving/persisting the row is NOT verifiable from this suite (no way to mint a Clockify-signed `/api/entries` read) — says so explicitly rather than claiming to have checked it | Same blocked pattern as LV-01 |
| **LV-03** | Captures a real entry's shape before deleting it via `CK_LIVE_API_KEY`, seeds it as if the webhook had delivered it, drives the real `/api/entries/preflight` → `/api/entries/recreate` path, verifies the new entry (including a non-default custom-field value) against real Clockify, cleans up | `blocked — no valid live installation (missing CK_LIVE_API_KEY)` |
| **LV-04** | Real `createForUser` targeting a genuinely different workspace member than the token signer (the R11 REST-level question); requires ≥2 ACTIVE workspace members — reports a distinct, non-credential "blocked" reason if the workspace only has one | Same blocked pattern (credential check runs first) |
| **LV-05** | A real archived tag (created + archived via the live API) and a deliberately non-existent projectId trigger P-PROJ-GONE + P-TAG-ARCH together; resolves both and recreates for real | Same blocked pattern |
| **LV-06** | N/A — struck through in docs/13, merged into LV-05. No file exists for it (not invented) | — |
| **LV-07** | Reads the REAL `onlyAdminsCanChangeBillableStatus`/`defaultBillableProjects` values and asserts P-BILL fires exactly when they say it should, for a regular AND an admin viewer. Deliberately never mutates the workspace-wide setting (disproportionate to a live proof; the rule's logic for both states is already proven offline, UT-P10) | Same blocked pattern |
| **LV-08** | Creates a real dropdown custom field, removes an option (P-CF-OPT), creates a real required field with no default (P-CF-REQ), resolves both, recreates, verifies both values on the new entry, tears the fields down | Same blocked pattern; also reports a distinct "blocked — workspace/plan-shape" if custom-field creation itself is rejected (e.g. plan does not support custom fields) |
| **LV-09** | Immediate visibility of a fresh create through the filtered `listForUser` read; `fingerprintMatches` round-trip against a real fetched entry; a running entry (`end` omitted) visible with `end:null`; a recording-passthrough `fetch` proves no real request the app issues ever carries a `start`/`end` windowed query parameter | Same blocked pattern |
| **LV-10** | (a) `RT_CHAOS_FETCH=lose-response`: real commit, reported as a timeout, AMBIGUOUS → reconcile adopts → RECREATED, verified against real Clockify. (b) `RT_CHAOS_FETCH=fail-before-send`: nothing sent, AMBIGUOUS → reconcile finds nothing → marked not-created → IDLE | Same blocked pattern for both legs |

**Proved without credentials** (the hard-gate mechanism itself, per the pass brief): the
`RT_CHAOS_FETCH` hook's mechanics are proved against a mocked transport in
`tests/integration/chaos-fetch-drill.test.ts` (7/7 passing) — both modes drive the documented
outcome, the hook touches only the `createForUser` POST (never a GET, proven with a live
`listForUser` call while the hook is active), and it is provably inert whenever
`NODE_ENV !== "test"`. This satisfies the pass file's "prove the hook itself works against a mocked
transport" instruction; `CK_LIVE_API_KEY` is the only thing standing between this and LV-10 running
for real.

**Also proved with real (deliberately wrong) credentials**: run twice against production Clockify
with a syntactically valid but fake API key (`lv-07`, `lv-05`) — both failed loudly with a real
`401`/`4017` from `api.clockify.me`, not silently. This confirms the "blocked" reporting path is not
the ONLY path these tests can take, and that the transport/error-handling code is real, working,
unmocked network code. See evidence/live-release-run.md §2.1 for the full transcript.

## 6. docs/16 box-by-box state

See `docs/16-definition-of-done.md` directly — every box now carries either a checkmark or a
one-line reason. docs/16 has 19 boxes in three groups: 10 "Contracts", 5 "Quality bars", 4 "Release
gates". **14 checked, 5 unchecked.**

**Checked (14/19)**: 9/10 "Contracts" boxes (all except the one that explicitly names LV-03/LV-04
as its own evidence); 4/5 "Quality bars" boxes; 1/4 "Release gates" box (the rollback drill).

**Unchecked, with reasons (5/19)**:
- The one "Contracts" box naming LV-03/LV-04 as its own evidence — offline mechanics proven, live
  re-confirmation not run.
- "green on `main`" (Quality bars) — green on this branch; not yet merged (merging is the
  operator's action).
- Live suite LV-01…LV-10 (Release gates) — blocked on `CK_LIVE_API_KEY` / `CK_LIVE_ADDON_BASE_URL`.
- Marketplace manifest review package (Release gates) — staged and complete per docs/15's own
  prerequisites list; a real submission additionally needs operator-supplied
  icon/screenshots/description/host.
- GitHub release tagged (Release gates) — reserved for the operator per
  `implementation/passes/PASS-05-release.md` ("Git requirements") and this pass's own scope.

## 7. Operator inputs still required (complete list)

1. **`CK_LIVE_API_KEY`** — a Clockify personal API key valid against **production**
   `api.clockify.me` for the sacrificial workspace. (Confirmed distinct from the
   developer-environment key already in use for `tests/dev-smoke/` — that key returns
   `401 {"code":4003}` against production, per the pass brief's own verification.)
2. **`CK_LIVE_WS`** — the sacrificial workspace ID on production (may be the same ID as the
   developer-environment sacrificial workspace, `65b382b606de527a7ee2b60e`, or a different one —
   the operator confirms which).
3. **`CK_LIVE_ADDON_BASE_URL`** — the public base URL of a RestoreTime instance already deployed
   AND already installed on the sacrificial workspace, for LV-01/LV-02 only. This requires the
   deployment step (docs/15 pipeline steps 2-3) to have already happened — deployment
   host/orchestrator, `PUBLIC_BASE_URL`, DNS, and TLS are all operator decisions this pass was told
   not to invent.
4. **Marketplace listing assets**: icon artwork (if the sidebar SVG is not also the Marketplace
   listing icon), screenshots (need a real running instance to capture), and a long-form listing
   description (marketing copy, not manifest content).
5. **Merge + tag**: merging `pass-05-release` (or this worktree's branch) into `main`, and creating
   the `v1.0.0` tag — both explicitly reserved for the operator by the pass brief.

## 8. Deviations

- Branch name: harness-assigned `worktree-agent-a7a15410491982c02` rather than
  `pass-05-release` — same deviation PASS-04 recorded, for the same reason (the harness controls
  worktree/branch naming, not the pass file).
- `CK_LIVE_ADDON_BASE_URL` is a new environment variable, not named in docs/13's original text. It
  is sanctioned by the pass brief itself ("the moment the operator supplies `CK_LIVE_API_KEY` and a
  host") and is documented in docs/13 and docs/15 alongside the two variables that were already
  named there — not invented silently.
- `src/clockify/client.ts` changed to wire in the chaos hook. This is the one production-code
  change this pass made; it is additive (byte-identical `clientOptions` whenever the hook is
  inactive — proved by the "inert outside NODE_ENV=test" tests) and required no ADR revision, per
  the same reasoning `RT_TEST_CRASH_MID_ATTEMPT` (PASS-04) did not require one.

## 9. Self-review: the weakest part of this pass

The weakest part is unavoidable, not a shortcut: **no row of LV-01…LV-10 has ever actually run
against real Clockify**, because no live credential exists in this environment. Everything in this
report is either (a) real, unmocked evidence gathered without those credentials — the Docker
build/run, the rollback drill, the deliberately-wrong-credential runs, the offline chaos-hook
proof — or (b) code that I am confident is correct based on the SDK's documented request/response
shapes and this repository's own established test patterns, but that confidence is exactly what LV
exists to convert into evidence, and it has not been converted yet.

Two secondary risks, both isolated to fixable narrow spots rather than the design:

- **LV-04 and LV-08 depend on workspace shape** (≥2 active users; custom-field creation permitted
  on the plan) that I cannot verify without credentials. Both report a distinct, honest "blocked"
  reason if the shape is wrong, rather than failing in a way that looks like a code defect — but if
  the real sacrificial workspace does not meet these shapes, those two rows will need a workspace
  adjustment (adding a second member; confirming custom-field support) before they can run for
  real, and that is outside what code alone can fix.
- **The `runReconcile`/store-layer fallbacks in LV-10 and the direct `entries.markNotCreated` call
  in LV-10(b)** intentionally bypass the HTTP route's UI-facing throttle/cooldown windows
  (`RECONCILE_THROTTLE_MS`, `MARK_NOT_CREATED_MIN_CHECKS`/`MARK_NOT_CREATED_WINDOW_MS`) to avoid a
  multi-minute-long live test. This proves the reconcile mechanics correctly, which is what LV-10
  is for, but it does not exercise the UI cooldown timers themselves live — those are already
  proven offline (IT-04) and were a deliberate scope line, not an oversight, but it is the kind of
  line another reviewer could reasonably draw differently.
- **Every harness row asserts `plan.blockers`/`plan.actionRequired` are empty before recreating.**
  That only holds if the real sacrificial workspace has `forceProjects`, `forceTags`, and
  `forceDescription` all off, and no `required` custom field lacking a `workspaceDefaultValue`
  beyond the ones LV-08 creates and tears down itself. Concretely: LV-09 and LV-10 seed
  `projectId: null` — with `forceProjects: true` live, preflight would emit `P-PROJ-REQ` and
  `/api/entries/recreate` would return 422, a failure that would have nothing to do with R10 or the
  ambiguity protocol. LV-03 sends a non-dropdown custom field's first non-inactive value as a plain
  string — if that field turns out to be `NUMBER`-typed, or a second required field with no default
  exists, `P-CF-REQ` fires the same way. None of this needed fixing to ship this pass (workspace
  configuration is the operator's to confirm, and it is genuinely unknown from here), but the
  operator should read it before the first live run rather than discover it as an unexplained 422.

Two things the advisor review caught and this pass fixed before landing, named here because a
silent fix undersells what "reviewed" means:

- `tests/live/support.ts`'s `recordingPassthroughFetch` (LV-09) originally called the bare `fetch`
  identifier inside its own closure. Once installed as `globalThis.fetch` (exactly how LV-09 uses
  it), that identifier resolves to the wrapper itself at call time — infinite recursion, stack
  overflow, on the first request. Fixed by capturing `REAL_FETCH` once at module load, before any
  stubbing; `tests/live/support.test.ts` (new, credential-free, always runs) proves the fix by
  driving one real request through the installed wrapper and asserting the failure is a normal
  connection error, not a `RangeError`. Verified the test itself catches the regression by
  temporarily reverting the fix and re-running — it failed with the exact `RangeError` predicted.
- This report's own docs/16 box count was wrong in an earlier draft (said 17 total boxes; the file
  has 19). Recounted directly from the file rather than from memory; see §6.

## 10. What I could not do

Run any part of LV-01…LV-10 for real, deploy anywhere, or produce a Marketplace-ready icon/
screenshots/description/host — all correctly blocked on operator inputs named in §7, not worked
around.

---

## Adversarial review (added by the judging author)

An independent reviewer worked in its own worktree, ran every gate, built and booted the image,
and exercised both the blocked path and the wrong-credential path against real `api.clockify.me`.

Its most important result is a negative one: **it tried to falsify every checked docs/16 box and
could not.** No false checked box, no fabricated verification, no credential in the tree, no
dependency outside the closed list. **No blocking findings.** Eight others, all fixed.

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| F1 | high | Shape-gated LV rows `return`ed instead of skipping, so a **credentialed** run could print "11 passed" while the load-bearing scenario never ran — LV-04 (the row that closes R11) went green on a one-member workspace, behind a tautological `expect(active.length).toBeGreaterThanOrEqual(0)`. | **Fixed.** LV-04 and LV-08 now call `ctx.skip(reason)`, so vitest reports them as **skipped**, not passed; the tautological assertion is gone. LV-03's partial run prints `LV-03 PARTIAL` and names LV-08 as the row that pins what it could not. |
| F2 | high | LV-08's `catch` swallowed **any** error from custom-field creation into "workspace/plan-shape gap" and passed green — so a transient 500 or a mid-run 401 would be reported as a plan limitation. Exactly the swallow a blocked path must never have. | **Fixed.** Only a 400/402/403 refusal is treated as a plan-tier gap; everything else rethrows. |
| F3 | med | LV-10 leg (b) asserted only that the row stayed AMBIGUOUS — equally true if the immediate reconcile threw and never reached Clockify, since the route swallows a failed first check by design. | **Fixed.** It now asserts the reconcile was actually recorded: `checks >= 1`, `matchCount === 0`, `truncated === false`. |
| F4 | med | The privacy text claimed RestoreTime stores "who deletes" an entry. No deleter exists anywhere — W13 proves the deletion event carries the owner, never the actor. | **Fixed.** The line now says "who owned the entry, and who recreates it later", and the "never stores" list gains an explicit entry saying there is no deleted-by data, citing W13. |
| F5 | low | `evidence/live-release-run.md` claimed no "workspace-identifying value" appears, then quoted the sacrificial workspace id. | **Fixed.** The claim now covers credentials and tokens, and says plainly that the workspace id appears and is already recorded elsewhere in `evidence/`. |
| F6 | low | docs/16 and the report said "all ten rows are implemented"; nine files exist (LV-06 is merged into LV-05 by docs/13). | **Fixed** in both. |
| F7 | low | The live harness stored the operator's **real production API key** encrypted under a fixed all-zero key — effectively plaintext — in a temp directory a killed run would leave behind. | **Fixed.** A per-boot `randomBytes(32)` key. |
| F8 | low | The rollback-drill box did not carry the caveat that "one component load" was satisfied by the 401 boundary and assets, not an authenticated render. | **Fixed.** The box now states the caveat and points at the docs/15 step-6 production smoke. |

F1 and F2 are the ones that mattered most, and neither affects this run — both change what a
**future** credentialed run will report. That is the point: this pass could not run the live suite,
so its remaining job was to make sure the run that can is impossible to misread.
