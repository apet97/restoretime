# 15 — Release

The release workflow for the implementation that follows this blueprint. Values marked
`<operator>` are environment-specific and must be supplied at release time; nothing else is
placeholder.

## Repository

- Remote: `github.com/apet97/restoretime` (created at planning time; private until release).
- Branching: `main` is protected; feature branches merge by PR with CI green.
- Versioning: SemVer. Tags `v0.1.0` (first deployed build) … `v1.0.0` (Marketplace submission).

## CI gates (every PR)

1. `npm ci`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run test` (unit + contract + integration)
5. `npm run build` (server bundle + UI bundle)
6. Secret scan of the diff (no tokens, no API keys — the repo must never contain any; see
   `AGENTS.md`).

## Release pipeline (tag push)

1. All CI gates.
2. Build the container image; tag with the release version.
3. Deploy to the production environment `<operator: host/orchestrator>`.
4. Run migrations at boot (automatic).
5. Live suite (`npm run test:live`) against the sacrificial workspace with the production build's
   public URL wired as the webhook/component base:
   `LV-01…LV-10` must pass. This closes the addon-token success-path question (R11) and proves
   the ambiguity protocol live (LV-10) before any Marketplace submission.
6. Production smoke: install on the sacrificial workspace, delete one entry, recreate it, confirm
   the success view.
7. Tag the release on GitHub with release notes.

## Marketplace submission prerequisites

- Manifest validated at boot (`createValidatedClockifyAddon`) and reviewable at `GET /manifest`.
- Scopes requested (minimum set): `TIME_ENTRY` READ+WRITE, `PROJECT` READ, `TASK` READ, `TAG`
  READ, `USER` READ, `CUSTOM_FIELDS` READ, `WORKSPACE` READ. Justification for each is in the
  submission text: reads feed preflight; write creates the new entry.
- `minimalSubscriptionPlan`: FREE unless review evidence demands otherwise.
- Privacy text: what is stored (docs/08), uninstall purge behavior (F17), no raw payload retention
  (ADR-009).
- Rollback proof: the previous image redeploys and boots against the pre-migration backup.

## Rollback

1. Stop the current image.
2. Restore the database file from the pre-release backup if a migration ran.
3. Start the previous image.
4. Verify `/healthz` and one component load.
Record the drill result in the release notes of each version.

## What a release is NOT

- A planning-repo push (the state created by the blueprint pass) is not a product release and is
  never tagged as one.
