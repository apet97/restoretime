# 14 — Operations

Proportional to a single-process addon. No observability platform.

## Health

- `GET /healthz` → 200 with `{status:"ok", db:"ok"}` after a `SELECT 1`. No auth. Used by the
  deploy target's liveness check.

## Logging

- Structured JSON lines to stdout: `{ts, level, msg, ...fields}`.
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
- Environment: the six variables from docs/05. The deploy target is operator choice (a VM, a
  container, or a PaaS all satisfy the shape); the release workflow (docs/15) builds one container
  image as the reference artifact.
- Database file on a persistent, encrypted volume. Backup = stop-gap copy with WAL checkpoint
  (`PRAGMA wal_checkpoint(TRUNCATE)` then copy) — daily is proportionate.
- Rollback: previous container image + database file from before the migration. Migrations are
  forward-only; a rollback that crosses a migration restores the older file from backup.

## Routine operations

- Installation marked broken (4017): component shows a reinstall notice; reinstall replaces the
  installation row (new INSTALLED payload) and clears the flag.
- Clockify outage: preflight fails with "Clockify could not be reached"; webhook ingestion returns
  5xx so deliveries retry (W10); no operator action.
- Disk growth: the database holds only deleted-entry records; growth is proportional to deletion
  volume. Review retention (docs/08) before adding any expiry job.
