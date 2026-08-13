# 14 — Operations

Proportional to a single-process addon. No observability platform.

## Health

- `GET /healthz` → 200 with `{status:"ok", db:"ok"}` after a `SELECT 1`. No auth. Used by the
  deploy target's liveness check.

## Logging

- Structured JSON lines to stdout: `{time, level, msg, ...fields}`.
- Allowed fields: route, status, workspace id, entry ids, lifecycle states, error status/code,
  durations, attempt/plan ids.
- Never logged: webhook bodies, entry descriptions, custom-field values, tokens, auth headers
  (platform redaction via the SDK `onError` hook; app loggers follow the same rule — N3).
- Level via `LOG_LEVEL`. Default `info`.

## Metrics

Counter/gauge log lines (`metric:` prefix) are enough at this scale; any scraper can parse them.
Emit: `webhook_received`, `webhook_rejected`, `webhook_duplicate`, `recoverable_created`,
`preflight_blockers`, `preflight_action_required`, `recreate_attempt`, `recreate_success`,
`recreate_failed`, `recreate_ambiguous`, `ambiguous_adopted`, `ambiguous_not_created`,
`authz_denied`.

## Error reporting

The addon SDK `onError` hook receives redacted requests. Wire it to the same structured logger.
Uncaught handler errors → 500 + log. No external error tracker in v1; add one behind the logger if
volume ever justifies it.

## Migrations

Numbered SQL files (`src/store/migrations/0001_init.sql`, …) applied at boot inside a transaction,
tracked by `user_version`. Add-only changes in normal feature work; destructive changes need a
documented migration path in the release notes.

## Deployment

- Single Node 22 process behind TLS. `PUBLIC_BASE_URL` is the public origin.
- Environment: the seven variables from the docs/05 §Configuration table. The deploy target is operator choice (a VM, a
  container, or a PaaS all satisfy the shape); the release workflow (docs/15) builds one container
  image as the reference artifact.
- Database file on a persistent, encrypted volume. The image runs as UID/GID 1000. A mounted
  volume replaces the image's `/data` ownership, so verify that the mounted directory is writable
  by 1000:1000 before the first boot. Run exactly one application instance against a SQLite file.
  On Railway, do not configure replicas for a service that has a volume. Require exactly one
  running deployment instance instead. Set `RAILWAY_RUN_UID=1000` for the final service. A
  Railway SSH command runs in a root diagnostic shell, so do not use that shell's UID as the
  application proof. Read the UID of PID 1 (`node dist/server.js`) from `/proc`.
- For a file-copy backup, quiesce requests, stop the Node process, and confirm that no writer
  remains. Open the file with SQLite, run `PRAGMA wal_checkpoint(TRUNCATE)`, close that connection,
  and then copy the database. Confirm that no `-wal` or `-shm` sidecar remains. If the process must
  stay live, use SQLite's online backup API instead. Do not copy one file from a live WAL database
  and assume that it is complete.
- Verify each release backup on a separate path: open it read-only, require
  `PRAGMA integrity_check` to return `ok`, record `PRAGMA user_version`, and boot the compatible
  image recorded with that backup against a disposable copy. Keep the original backup
  unchanged. Test an older image only with its matching pre-migration database copy.
- Rollback: previous container image + database file from before the migration. Migrations are
  forward-only; a rollback that crosses a migration restores the older file from backup.

## Performance

`GET /api/entries` fetches the four workspace-level lookups (settings, users, tags, custom fields)
once per request and reuses one project/task lookup per distinct `projectId` across every listed
row (`src/clockify/preflight-data.ts` `ProjectTaskCache`), instead of once per row — the N+1 a
PASS-02 row-by-row implementation would otherwise have (docs/13's `performance.test.ts` pins the
exact call count: one lookup per distinct project, not per actionable row). The suite also records a local,
stub-backed p95 for `GET /api/entries` over 5000 seeded rows (50 actionable across 5 projects):
typically 25–45 ms on a quiet machine.

That number is **recorded, not gated**. It measures whatever CPU the machine has spare: the same
commit produced under 150 ms and 2.3 s on the same laptop, the only difference being a container VM
running alongside the suite. The test therefore asserts only a catastrophe ceiling
(`LOCAL_P95_CATASTROPHE_MS`, `tests/integration/performance.test.ts`), and the load-independent
guard against the N+1 returning is the call-count assertion described above. Neither number is a
production SLA — there is no real Clockify network latency in either.

## Routine operations

- Installation marked broken (4017): component shows a reinstall notice; reinstall replaces the
  installation row (new INSTALLED payload) and clears the flag.
- Clockify outage: preflight fails with "Clockify could not be reached"; webhook ingestion returns
  5xx so deliveries retry (W10); no operator action.
- Disk growth: the database holds normalized deleted entries, plans linked to attempts, and
  recreation attempts. A preflight deletes older unattempted STALE or CONSUMED plans for that
  deleted entry. Growth therefore follows deletion and recreation volume, not every preflight
  forever.
  Review retention (docs/08) before adding an expiry job.
