# 15 — RC.11 release

This workflow releases `v1.0.0-rc.11` for developer-environment evaluation. It does not deploy to
Clockify production and it does not submit the add-on to the Marketplace. Do not use a successful
RC.11 run as proof for either boundary.

## Repository

- Remote: `github.com/apet97/restoretime`. This document does not claim a repository visibility
  setting.
- A feature branch merges to `main` through a manually reviewed PR with green CI. Before merge,
  inspect and record the current branch-protection or ruleset settings. Workflow files cannot
  prove this external setting. If the host does not enforce the required review, stop and apply
  the manual review policy before merge.
- The RC.11 candidate is the exact merge commit on `main`, not the branch head before merge.
- `v1.0.0-rc.11` is a prerelease tag. A stable `v1.0.0` remains blocked by production and
  Marketplace proof.

## CI gates (every PR)

1. `npm ci`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run test` (unit + contract + integration)
5. `npm run test:e2e` (builds the server and UI bundles once, then runs the component journeys)
6. Secret scan of the CI change set (no tokens or API keys; see
   `AGENTS.md`).

## RC.11 pipeline (manual, not tag-triggered)

### RC.11 operator amendments

For RC.11 and later verification of this candidate, run the reachable-ref gitleaks scan with
`--all`, `--redact=100`, and a `300` second timeout. Do not reduce the scan scope, scan ignored
`.env.live` files, or inspect a finding for a secret value. A finding blocks the release.

Railway platform backup/PITR and an isolated Railway platform restore are **NOT PROVEN — deferred
infrastructure capability**. Railway requires Pro for this capability. The operator waived these
three gates only for this RC prerelease: platform backup/PITR, locked Railway backup, and isolated
Railway platform restore. Do not purchase or enable Pro for this release. This waiver permits the
RC prerelease. It does not prove production disaster-recovery readiness.

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
   For the local migration and rollback drill, create a temporary version-2 database with
   migrations `0001` and `0002`, and seed one known row. Verify the seed and require
   `PRAGMA integrity_check` to return `ok`. Preserve one unchanged backup. Start the candidate on
   a copy of that database. Require migration to version 3, the seeded row, and
   `PRAGMA integrity_check` to return `ok`. Stop the candidate. Confirm that no process holds the
   drill database or volume. Restore a copy of the preserved version-2 backup into that same drill
   database or volume. Start the recorded prior image by its immutable digest. Require health and
   the seeded row. Require `PRAGMA user_version` to return `2` and `PRAGMA integrity_check` to
   return `ok`. Keep the preserved backup unchanged. Delete only the temporary drill containers,
   database copies, and volumes after all results are recorded.
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
   component load. Retain the prior volume as the rollback target. This proves the RC.11 backup
   can be restored; it does not by itself prove that an older image can read a version-3 database.
   Record the separate local version-2 migration and rollback drill from step 3. A fresh Railway
   project has no prior remote database to use for that drill.
   For RC.11, the operator amendment above waives this step as a blocking gate. Record it as
   `NOT PROVEN — deferred infrastructure capability`. Do not mark it as passed or claim that
   Railway backup, PITR, or disaster recovery was proved.
9. Only after steps 1–7 and every non-waived gate pass, create `v1.0.0-rc.11` on the exact merged
   `main` commit. Publish it as a GitHub prerelease. The notes must list the developer-only proof,
   image digest, live-test totals, cleanup result, the deferred Railway backup/PITR status, and the
   open production and Marketplace gaps.

## Future Marketplace submission prerequisites

RC.11 does not satisfy or execute a Marketplace submission. The later submission must meet all of
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

## Explicit gaps after RC.11

- No deploy or smoke test uses `CLOCKIFY_PARENT_ORIGIN=https://app.clockify.me`.
- No production Clockify workspace proves installation, signed component rendering, webhook
  delivery, or recreation for this commit.
- No Marketplace review or installation has occurred.
- Therefore RC.11 does not authorize the stable `v1.0.0` tag.

## What a release is NOT

- A planning-repo push (the state created by the blueprint pass) is not a product release and is
  never tagged as one.
- A developer Railway deployment is not a production deploy.
- A passing diagnostic `npm run test:live` run is not strict live-release proof.
