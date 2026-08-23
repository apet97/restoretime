# 15 — Release process and RC receipts

This document records `v1.0.0-rc.14` and `v1.0.0-rc.15` for developer-environment evaluation. It
does not deploy to Clockify production and it does not submit the add-on to the Marketplace. Do
not use a successful RC run as proof for either boundary.

## RC.15 release receipt

RC.15 applies only to `fdbb89b58cdca759ca988f9ab1dda3ac3020e694`, the `main` tip at session start
on 2026-08-23. [Main CI run 32660184242](https://github.com/apet97/restoretime/actions/runs/32660184242)
passed for that commit, and `origin/main` resolved to it at declaration. There is no candidate
PR: the operator's 2026-08-23 authorization (recorded in docs/16 "Operator authorization for
RC.15") directed a direct-to-main workflow for this candidate and permanently waived branch
protection and enforced release-candidate CI beyond ordinary CI. The annotated `v1.0.0-rc.15`
tag peels to the exact candidate, and GitHub published it as a prerelease.

The developer deployment is `13bb1ee7-b690-47e6-b3bc-63aebbff643b` on the existing Railway
project `bf8d46ae-5661-4fa1-9998-813e45bba253`, environment `3303ec5b-b554-4e96-b69e-32a020dd2ba9`,
service `a9e02dc6-aa34-41f2-9d5e-36b8ad82bee6`, replacing `cd4808d6-9e99-4fa2-8be2-e9eb7f3fc414`.
Its instance is `c293712f-0015-46c6-ab74-6c3d985ec044`. Its image digest is
`sha256:bfe346c69b2ac256aa22bddff5a51219a63a5e110965f539dcf788509d86f9eb` — identical to the
three prior evaluation deployments, as expected: the application-source fingerprint
`d14273d42e7b932ae2320c5edec3648c1a84a0360c5f5b6fc41013d17f6f4642` is unchanged since `e3a920d`
(every later commit is docs-only for the fingerprint inputs). `railway up` ran from a fresh
clone detached at the exact candidate with `RESTORETIME_CANDIDATE_ID` set before the deploy;
inside the container that variable reads the exact candidate commit, PID 1 runs
`node dist/server.js` as UID/GID 1000, `/healthz`, `/manifest`, `/icon.svg`, `/static/app.js`,
and `/static/app.css` are served, and `/component` and `/api/entries` answer 401
unauthenticated.

Candidate-bound local gates ran from that same fresh clone (receipt `local-gates-fdbb89b.md` in
`restoretime-fdbb89b-evidence/` outside the repository): Node 22 typecheck, lint, 502 offline
tests in 49 files, 111 E2E tests in 12 files, root and install-capture npm audits (0
vulnerabilities each), the reachable-ref gitleaks scan (`--log-opts=--all --redact=100` under a
300-second bound; 83 non-merge commits of 102 reachable refs, no leaks, exit 0), the local
Docker health and `SIGTERM` gate (`{"status":"ok","db":"ok"}`, `HEALTHCHECK` healthy, `SIGTERM`
exit 0 in 0.19 s, no `-wal`/`-shm` residue, `integrity_check` `ok`, `user_version` 5, baked
fingerprint equal to `sourceFingerprintFromGit`), and the migration and rollback drill in its
current shape (3 → 5 → rollback; the seeded row survived migration attributed to its
installation's `addon_id`, `foreign_key_check` empty, the preserved pre-migration backup
sha256-unchanged, and the prior image the fingerprint-verified `restoretime:rc14-2d5e7fb`
stand-in — the recorded substitution step 3 permits while the rc.14 Railway digest stays
unpullable).

`npm run test:live:release` passed **three times** against the deployed candidate: 13 files and
45 tests, exit 0, zero skips and zero blocked rows, plus the separate cleanup suite each time.
LV-01B and LV-02B receipts in `restoretime-fdbb89b-evidence/` name this exact candidate,
deployment `13bb1ee7`, instance `c293712f`, and installation `6a8a55823e328737e6b9556c` — no
reinstall happened, so the generation the rc.14-era receipts proved is the one still live.
LV-02B names LV-02A's printed source ID `6a8b4c3b3e328737e6b96be3`, pinned to this deployment's
only `webhook_received`/`recoverable_created` log pair by the persisted row's `detected_at`
falling between the pair's millisecond timestamps. LV-01B carries the authenticated iframe
render with a component JWT naming this `addonId`, the active sidebar item with this
deployment's `/icon.svg`, the developer CSP (`frame-ancestors https://developer.clockify.me`,
`connect-src 'self'`), and a measured cache-bypassing top-level load with zero console errors,
zero CSP errors, and seven of seven requests answered 200 — the zeros proven real by a control
`console.error` recorded and cleared in the same buffer before the measured load.

Cleanup: the suite's teardown removed its Clockify probes, and the separate operator step then
cleared the 31 captured probe rows from the deployed volume
(`deployed-db-probe-cleanup-output.txt`), after which the deployed database matched the pre-run
baseline line-for-line (`deployed-db-baseline-pre-run.txt` vs `deployed-db-post-run.txt`,
`diff` clean): the developer generation holds only its single pre-existing recreated row, the
other workspace's installation and 4 rows are untouched, `recreation_plans` 4 and
`recreation_attempts` 3 as before, `integrity_check` `ok`, `user_version` 5. The final
workspace scan covered all 10 users including deactivated ones, every page, active and archived
tags, and every custom field: zero `RT-PROBE-` artifacts and zero read failures, reported
explicitly.

Permanently waived by the operator for RC.15 and future candidates (docs/16 "Operator
authorization for RC.15" is the record): Railway platform backup, PITR, and isolated-restore
proof — **NOT PROVEN — permanently waived by operator** — plus branch protection, enforced
release-candidate CI beyond ordinary CI, and Marketplace submission. Dependency major upgrades
stay deliberately skipped. No paid plan was purchased or enabled. These waivers do not prove
production, Marketplace, stable-release, or disaster-recovery readiness. The later
documentation receipt commit is not the RC.15 application candidate. Do not redeploy or retag
RC.15 because this documentation moves after publication.

## Repository

- Remote: `github.com/apet97/restoretime`. This document does not claim a repository visibility
  setting.
- A feature branch merges to `main` through a manually reviewed PR with green CI. Before merge,
  inspect and record the current branch-protection or ruleset settings. Workflow files cannot
  prove this external setting. If the host does not enforce the required review, stop and apply
  the manual review policy before merge.
- The RC.14 candidate is the exact merge commit on `main`, not the branch head before merge.
- `v1.0.0-rc.14` is a prerelease tag. A stable `v1.0.0` remains blocked by production and
  Marketplace proof.
- A clean checkout is an isolated clone or worktree at the exact candidate commit. Do not script a
  destructive removal of a developer's modules or files to create one.

## RC.14 release receipt

RC.14 applies only to `2d5e7fbf3507d520456d60f69f70e29e78d9edb9`. Pull request
[37](https://github.com/apet97/restoretime/pull/37) merged the reviewed candidate to `main`.
[Main CI run 31914913974](https://github.com/apet97/restoretime/actions/runs/31914913974) passed
for that commit. [Issue 38](https://github.com/apet97/restoretime/issues/38) recorded the
developer-only authorization and explicit backup waiver. The annotated `v1.0.0-rc.14` tag peels to
the exact candidate, and GitHub published it as a prerelease.

The developer deployment is `5b8d235f-4d3f-468f-be5b-1426cbed80a0`. Its instance is
`c3e2dcfe-66f5-4778-8441-026e96306317`. Its image digest is
`sha256:760176c2d1bdc791db941a0aef8df0d81901bdde02979378bb872b2ec80ccd2a`, and its source
fingerprint is `7bc7fe441e72324eee10b0f4c08ffa07a32fe3efec23148290a3f188783d94c3`. Local gates
passed 44 files and 472 tests. E2E gates passed 12 files and 104 tests. Strict live gates passed
13 files and 45 tests with zero skips. Final cleanup found zero `RT-PROBE-` entries, tags, and
custom fields.

Railway backup creation, backup locking, and an isolated restore are **NOT PROVEN — explicitly
waived for RC.14**. This waiver does not prove production, Marketplace, stable-release, or
disaster-recovery readiness. The later documentation receipt commit is not the RC.14 application
candidate. Do not redeploy or retag RC.14 because this documentation moves after publication.

## Post-RC.14 developer deployments

On 2026-08-17, developer deployment `6f7ad68d-5cc6-48e9-bc39-4874c8ba7d32` replaced
`5b8d235f-4d3f-468f-be5b-1426cbed80a0` in the developer environment. It runs commit
`6306c1c506044d296150560833638d9b4954ae2a` (pull request 40, UI polish) with
`RESTORETIME_CANDIDATE_ID` set to that commit. This is an evaluation deployment, not a release
candidate. The RC.14 receipt above stays bound to its own commit, deployment, and instance; the
strict handoff in the candidate pipeline must target the currently selected deployment.

On 2026-08-23, developer deployment `9f425551-2535-4685-b4f9-9a7a2e778f91` replaced
`6f7ad68d-5cc6-48e9-bc39-4874c8ba7d32`. It runs commit
`538440823296786ee7296ea394e536ffb3e4db69` (pull request 42, installation-generation boundary) with
`RESTORETIME_CANDIDATE_ID` set to that commit, deployed with `railway up` from a clean checkout of
it. This is an evaluation deployment, not a release candidate.

Verified on that deployment, against the developer workspace `69bda6b317a0c5babe34b4ff`:

- Migrations 0004 and 0005 applied to the live volume. `user_version` 5, 158 rows preserved across
  two workspaces, every row owned by an existing installation, `integrity_check` `ok`,
  `foreign_key_check` empty — matching the drill run beforehand on a copy of the same database.
- `/healthz`, `/manifest`, `/icon.svg`, `/static/app.js`, `/static/app.css` served; `/component`
  and `/api/entries` answer 401 unauthenticated.
- List traversal: 4 pages, 153 rows, 153 unique ids, no repeats. Load more in the component walked
  50 → 100 → 150 → 153 and then withdrew. A malformed cursor and a `limit` above the cap were each
  answered 400.
- Component reload with cache bypass produced zero console errors, zero CSP violations, and no
  failed subresource loads.
- Capture and recreation: a deleted entry was captured under the current generation and recreated
  through the component into a genuinely new Clockify entry with the same values — exactly one
  match, a different id from the original.
- Uninstall purged that installation's 156 rows and left the *other* workspace's installation and
  4 rows untouched, recording the generation as retired.
- **Reinstall issued a fresh `addonId`** (`6a8a5582…`, distinct from the retired `6a7fd73e…`),
  confirming the assumption the ownership model rests on. The new generation started empty and
  captured its own deletion under its own id.
- Probe entries and rows removed afterwards; an orphaned `restoretime.sqlite` from a superseded
  `DATABASE_PATH` was deleted from the volume.

Railway backup, point-in-time recovery, and isolated restore remain **unproven**, `main` and
release tags are **unprotected**, and the release-candidate gates beyond ordinary CI are **not
enforced** by the merge path. This deployment therefore carries no production or Marketplace
readiness claim.

On 2026-08-23, developer deployment `fdce441f-145b-4366-a88b-ef3c1ba81d90` replaced
`9f425551-2535-4685-b4f9-9a7a2e778f91`. It runs commit
`e3a920d2c3eec94b5b9e505c7bc5f28ae9beb018` (pull request 43, defect sweep and component design
pass) with `RESTORETIME_CANDIDATE_ID` set to that commit, deployed with `railway up` from a clean
checkout of it. This is an evaluation deployment, not a release candidate.

Verified on that deployment, against the developer workspace `69bda6b317a0c5babe34b4ff` seeded with
60 created-then-deleted entries:

- All 60 captured under the current generation; list renders 50 with `Showing 50 entries.`
- **Load more appends**: 50 → 60 rows, note becomes `All 60 entries shown.`, and focus moves to
  that count when the last page removes the button — the keyboard regression this release fixes.
- **Zero `rt-primary` buttons on the list**; the only filled button on the detail view is
  `Continue to confirm`. That reservation is the point of the change.
- Cache-bypassing reload of the embedded component produced zero console errors, zero CSP
  violations, and no failed subresource loads.
- Detail view renders the compacted Differences block and the full comparison table.

**Date grouping was verified offline, not live, and deliberately so.** Rows group by *detected*
day, and every seeded entry is detected the moment it is deleted — so any API-driven seed renders
as a single group no matter how the entry dates are spread. Live confirms the single
`DETECTED AUG 23, 2026` heading and that a second page merges into the open group rather than
repeating it; multi-group rendering is covered by `tests/e2e/views.test.ts` and by the offline
preview renderings at light, dark, and 380px.

All seeded entries and rows were removed afterwards: zero `RT-` entries in Clockify, zero rows for
that workspace, and the other workspace's installation and 4 rows untouched throughout.

### 2026-08-23 — `17438570dfb97f0982e0617648bf7b914a1611e3`, the first live-suite run since the ownership change

Developer deployment `cd4808d6-9e99-4fa2-8be2-e9eb7f3fc414` (instance
`55d85742-e53e-409c-9521-1c714615d13f`) replaced `4f3c3060-f46e-45f0-bb15-6097540521a8`, which in
turn replaced `fdce441f-145b-4366-a88b-ef3c1ba81d90`. It runs commit
`17438570dfb97f0982e0617648bf7b914a1611e3` with `RESTORETIME_CANDIDATE_ID` set to that commit,
deployed with `railway up` from a clean checkout of it. This is an evaluation deployment, not a
release candidate.

All three deployments carry image digest
`sha256:bfe346c69b2ac256aa22bddff5a51219a63a5e110965f539dcf788509d86f9eb`, and
`sourceFingerprintFromGit` returns
`d14273d42e7b932ae2320c5edec3648c1a84a0360c5f5b6fc41013d17f6f4642` for `e3a920d`, `d29f53d`,
`1743857`, `f98bb4f`, `1a832d4`, and `8acb620` alike. Nothing under `src/` or the other
fingerprint inputs changed across those commits — everything after `e3a920d` is documentation
plus one test-harness fix (the commits after `1743857` touch only `README.md`,
`docs/15-release.md`, and `docs/16-definition-of-done.md`).

**`tests/live/` had not run since `(workspace_id, addon_id)` became the ownership key, and it did
not pass on the first attempt.** LV-03 through LV-10 failed before reaching Clockify: `liveScope`
named `CK_LIVE_ADDON_ID` — the Clockify-side installation id — while the in-process harness
installs under the synthetic `restoretime-live-addon`, so the generation fence answered
`installation-gone` to every seed. Fixed in `1743857` with
`tests/integration/live-harness-generation.test.ts` as the offline guard that was missing; removing
the fix turns that test red with the same outcome. The application source is untouched by the fix.

`npm run test:live:release` then passed, and was **reproduced three times**: 13 files and 45 tests,
exit 0, **zero skips and zero blocked rows**, plus the separate cleanup suite. The third run was
made from a detached checkout of the candidate commit, because the strict runner requires
`HEAD == CK_LIVE_CANDIDATE_ID` and `main` had by then moved on to this documentation commit. LV-01A, LV-01B, LV-02A,
LV-02B, and LV-03 through LV-10 all pass on this candidate, including LV-10's hard ambiguity gate
in both legs — a create that really committed while the caller saw a transport failure was adopted
by reconcile, and a create that was never sent stayed uncommitted.

Operator receipts for this candidate are in `restoretime-1743857-evidence/` outside the repository:

- **LV-01B** — the authenticated component rendered in the real developer Clockify iframe, with the
  component JWT carrying `addonId` `6a8a55823e328737e6b9556c`; the sidebar item **Time Entry
  Recovery** active with its icon served from this deployment's `/icon.svg`; the deleted-entry list
  loaded; the `/component` response carrying `frame-ancestors https://developer.clockify.me` and
  `connect-src 'self'`; and, on a cache-bypassing top-level load, zero console errors, zero CSP
  errors, and seven of seven requests answered 200. The zero counts are real zeros: a control
  `console.error` was recorded by the same buffer and cleared immediately before the measured load.
- **LV-02B** — deployment `cd4808d6` logged `webhook_received` at `2026-08-23T07:54:41.541Z`, and
  that deployment's own volume holds `recoverable_entries` row
  `5181d5f1-a81b-4c3d-85c0-e2417f7b55d0` with `source_entry_id` `6a8aa7403e328737e6b95ef8` and
  `detected_at` `2026-08-23T07:54:41.541Z`. Log lines carry no entry id by design, so the row's
  timestamp is what pins the log pair to the source id LV-02A printed.

Cleanup afterwards, independently of the suite's own teardown: a scan of all 10 workspace users
including deactivated ones, every page, plus active and archived tags and every custom field, found
**zero** `RT-PROBE-` artifacts and reported **zero** read failures — and reported zero read
failures explicitly, so a silent per-user error cannot pass as a clean result. Each run's probe
rows were then deleted from the deployed volume, leaving that generation with the single
pre-existing recreated row from the design-pass check; the other workspace's 4 rows were untouched,
`integrity_check` returned `ok`, and `user_version` stayed 5.

The suite's own teardown deletes probe entries, tags, and custom fields from Clockify, which is
what it verifies. It does not delete the `recoverable_entries` rows those deletions cause the
deployed add-on to capture — correctly, since that capture is the product working. Clearing them is
a separate operator step, scripted in `deployed-db-probe-cleanup.mjs` alongside the receipts.

Not proved by this run, and deliberately so: Railway backup, point-in-time recovery, and isolated
restore; a migration and rollback drill; reachable-ref secret scanning; the local Docker
health and `SIGTERM` gates; branch protection and enforced release-candidate CI; and anything on
production or the Marketplace. This deployment carries no production or Marketplace readiness claim.
Later on 2026-08-23 the drill (in its current 3 → 5 shape), the reachable-ref secret scan, and the
local Docker health and `SIGTERM` gates ran locally on the docs tip `8acb620` (fingerprint equal to
this candidate's); see docs/16 "Next-candidate gates" and the `local-gates-8acb620.md` receipt. The
other skips above stand.

On 2026-08-23, deployment `13bb1ee7-b690-47e6-b3bc-63aebbff643b` replaced `cd4808d6-9e99-4fa2-8be2-e9eb7f3fc414`.
It is not an evaluation deployment: it is the RC.15 candidate deployment, and its receipts are
in "RC.15 release receipt" above.

## CI gates (every PR)

1. `npm ci`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run test` (unit + contract + integration)
5. `npm run test:e2e` (builds the server and UI bundles once, then runs the component journeys)
6. Secret scan of the CI change set (no tokens or API keys; see
   `AGENTS.md`).

## Historical RC.13 candidate pipeline (manual, not tag-triggered)

### RC.13 operator authorization

[Issue 36](https://github.com/apet97/restoretime/issues/36) records the pre-publication backup
decision. The operator explicitly waived the RC.13 backup gates before tagging and publication.

Run the reachable-ref gitleaks scan with
`--all`, `--redact=100`, and a `300` second timeout. Do not reduce the scan scope, scan ignored
`.env.live` files, or inspect a finding for a secret value. A finding blocks the release.

Railway backup creation, backup locking, and an isolated Railway restore are **NOT PROVEN —
explicitly waived for RC.13**. Railway rejected backup creation on the current Hobby plan. The
operator waived these three gates only for this RC prerelease. Do not purchase or enable Pro for
this release. This waiver permits the RC prerelease. It does not prove production
disaster-recovery readiness.

A later candidate must have its own operator authorization and infrastructure-gate decision.

1. Open the PR. Complete the required manual review and all PR CI gates. Do not merge first and
   review later.
2. Merge the reviewed PR to `main`. Wait for the `main` CI run. Record the exact merged commit with
   `git rev-parse HEAD`, and verify that the remote `main` resolves to it. Stop if the commits
   differ.
3. From a clean checkout of that exact commit, use Node 22 and run the CI gates above. Build the
   local validation container. Record its immutable digest, platform, pinned base-image index
   digest, and application-source fingerprint at
   `/app/.restoretime-source-fingerprint`. Scan the image and reachable Git history for
   secrets with the approved release scanner. Railway performs a separate build in step 4. Deploy
   it from the same clean checkout. The source fingerprint checks accidental input drift; it is
   not a signed build attestation. Record the Railway image digest as the deployed artifact ID.
   The image scan must fail on a secret or on a high or critical finding when the vendor provides
   a fixed version. Record vendor-unfixed findings and their status. Stop if the application can
   reach the affected function or if the finding exceeds the accepted release risk.
   For the local migration and rollback drill, create a temporary database at the prior
   deployed image's schema version — boot that image on an empty volume so its own migration
   runner stamps the version (currently `user_version` 3, migrations `0001`–`0003`) — and seed
   one known row. Verify the seed and require `PRAGMA integrity_check` to return `ok`. Preserve
   one unchanged backup. Start the candidate on a copy of that database. Require migration to
   the current schema version (`user_version` 5, through migrations `0004` and `0005`), the
   seeded row still present and attributed to its installation's `addon_id`,
   `PRAGMA integrity_check` to return `ok`, and `PRAGMA foreign_key_check` to return no rows.
   Stop the candidate. Confirm that no process holds the drill database or volume. Restore a
   copy of the preserved pre-migration backup into that same drill database or volume. Start the
   recorded prior image by its immutable digest; when that digest lives only in Railway's
   internal registry and cannot be pulled, a local build of the same commit whose baked
   `/app/.restoretime-source-fingerprint` equals the recorded prior fingerprint may stand in,
   recorded as a substitution. Require health and the seeded row. Require `PRAGMA user_version`
   to return the prior version (currently `3`) and `PRAGMA integrity_check` to return `ok`. Keep
   the preserved backup unchanged. Delete only the temporary drill containers, database copies,
   and volumes after all results are recorded.
4. Create a new Railway project named `restoretime`. In it, create an environment named
   `restoretime` and a service named `restoretime`. This is not the production project. Deploy the
   repository `Dockerfile` from the exact merged commit with `railway up`, and record the resulting
   immutable image digest. Keep the volume-backed service at its default singleton. Do not
   configure Railway replicas because a service that has a volume cannot use them. Require exactly
   one running deployment instance and one persistent encrypted volume mounted at `/data`.
   Railway volume attachment causes deployment downtime, so plan this as a single-writer
   maintenance operation. Set `DATABASE_PATH` under `/data` and set all variables
   from docs/05. Set `CLOCKIFY_PARENT_ORIGIN=https://developer.clockify.me`, set `PUBLIC_BASE_URL`
   to this Railway deployment, and set the non-secret release metadata
   `RESTORETIME_CANDIDATE_ID=<full-merged-commit>`. Set it before `railway up` so it belongs to the
   candidate deployment. The application does not read this value during normal operation. The
   strict handoff uses it to reject a different deployment. If the new mount is not writable by
   UID/GID 1000, temporarily set `RAILWAY_RUN_UID=0` and deploy. In that exact deployment, use a
   Railway SSH command to assign `/data` and its existing files to UID/GID 1000. Setting the
   variable does not change file ownership by itself. Replace the variable with
   `RAILWAY_RUN_UID=1000` and deploy the candidate again. A Railway SSH diagnostic command runs as
   root. Do not use the SSH shell UID as proof. Read the UID of PID 1 from `/proc` and require
   `node dist/server.js` to run as UID/GID 1000. As UID 1000, prove that the process can create,
   write, and read the database under `/data`.
5. Verify `/healthz`, `GET /manifest`, `GET /icon.svg`, `GET /static/app.js`, and the unauthenticated
   `/component` boundary on the deployed digest. Install this exact candidate in the sacrificial
   developer workspace.
6. Record the exact Railway project, environment, service, deployment, and deployment-instance
   IDs. Set them as `CK_RAILWAY_PROJECT_ID`, `CK_RAILWAY_ENVIRONMENT_ID`,
   `CK_RAILWAY_SERVICE_ID`, `CK_RAILWAY_DEPLOYMENT_ID`, and
   `CK_RAILWAY_DEPLOYMENT_INSTANCE_ID`. Set `CK_LIVE_TARGET=developer`, the exact API-key user ID,
   workspace and add-on identities, the explicit developer API URL, the deployed HTTPS origin,
   and the full merged commit as `CK_LIVE_CANDIDATE_ID`. Do not use names, linked CLI defaults, or
   the newest deployment as selectors.
7. Use `scripts/live-env.sh <exact-railway-origin> ...` for both strict commands. It obtains the
   installation from the selected deployment through a memory-only encrypted handoff. It rejects
   a stale local installation row. Run `npm run test:live:trigger`. Record its exact source ID.
   Capture LV-01B proof of the working
   authenticated iframe, loaded list, icon, developer CSP, and zero console/CSP errors. Capture
   LV-02B from correlated Railway webhook logs and the exact persisted source row in remote
   SQLite. Both receipts must name the same commit; LV-02B must name the trigger source ID. Then
   run `npm run test:live:release`. The strict command fails on a missing prerequisite, mismatched
   receipt, skipped test, or incomplete cleanup. It must end with zero active `RT-PROBE-` entries
   across all current and deactivated workspace users and zero `RT-PROBE-` tags or custom fields.
   The diagnostic `npm run test:live` command is not a release gate.
8. In the same `restoretime` Railway project and environment, quiesce the writer and create a
   Railway volume backup by the procedure in docs/14. Lock that backup against expiration. The
   lock does not stop database writes and does not replace the operator deletion rule. Keep the
   writer quiesced until the backup is complete. Do not delete the backup or wipe its source
   volume.
   Record the image digest, database checksum, `PRAGMA integrity_check`, `PRAGMA user_version`, and
   backup location. Keep the original backup and prior volume unchanged. Restore a copy to an
   isolated replacement volume in the same project and environment, boot the recorded candidate
   digest against it, and verify `/healthz`, the expected schema version, and one authenticated
   component load. Retain the prior volume as the rollback target. This proves the candidate backup
   can be restored; it does not by itself prove that an older image can read the migrated
   database. Record the separate local migration and rollback drill from step 3. A fresh Railway
   project has no prior remote database to use for that drill.
   For RC.13, the operator authorization above waives this step as a blocking gate. Record it as
   `NOT PROVEN — explicitly waived for RC.13`. Do not mark it as passed or claim that
   Railway backup, PITR, or disaster recovery was proved.
9. Only after steps 1–7 and every non-waived gate pass, create `v1.0.0-rc.13` on the exact merged
   `main` commit. Publish it as a GitHub prerelease. The notes must list the developer-only proof,
   image digest, live-test totals, cleanup result, the explicitly waived Railway backup status,
   and the open production and Marketplace gaps.

## Future Marketplace submission prerequisites

RC.13 does not satisfy or execute a Marketplace submission. The later submission must meet all of
these conditions:

- Manifest validated at boot (`createValidatedClockifyAddon`) and reviewable at `GET /manifest`.
- Scopes requested (minimum set): `TIME_ENTRY_READ`, `TIME_ENTRY_WRITE`, `PROJECT_READ`,
  `TASK_READ`, `TAG_READ`, `USER_READ`, `CUSTOM_FIELDS_READ`, and `WORKSPACE_READ`. Justification
  for each is in the submission text: reads feed preflight; write creates the new entry.
- `minimalSubscriptionPlan`: FREE unless review evidence demands otherwise.
- Privacy text: what is stored (docs/08), uninstall purge behavior (F17), no raw payload retention
  (ADR-009).
- Rollback proof: the previous image redeploys and boots against a tested copy of the pre-migration
  backup. Do not test a restore by overwriting the only backup.

## Developer-candidate rollback

1. Stop the failed Railway deployment and confirm that no process holds the database.
2. Preserve the failed database for diagnosis. Never overwrite the only verified backup.
3. Reattach the retained prior volume, or restore a copy of the locked verified backup to a
   replacement Railway volume. If the deployment replaced an older image and applied a migration,
   restore the pre-migration database and the prior image together. Never start the prior image on
   the migrated database and call it a rollback.
4. Start the recorded rollback image by its immutable digest. Verify `/healthz`,
   `PRAGMA integrity_check`, the expected `user_version`, and one authenticated component load.

If the new Railway project has no prior image or pre-migration database, record that fact. In that
case, deleting the candidate project is an environment rollback, not cross-version database
rollback proof.

## Historical gaps after RC.13

- No deploy or smoke test uses `CLOCKIFY_PARENT_ORIGIN=https://app.clockify.me`.
- No production Clockify workspace proves installation, signed component rendering, webhook
  delivery, or recreation for this commit.
- No Marketplace review or installation has occurred.
- Therefore RC.13 does not authorize the stable `v1.0.0` tag.

## What a release is NOT

- A planning-repo push (the state created by the blueprint pass) is not a product release and is
  never tagged as one.
- A developer Railway deployment is not a production deploy.
- A passing diagnostic `npm run test:live` run is not strict live-release proof.
