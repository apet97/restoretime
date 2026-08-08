-- docs/08 "recoverable_entries", "recreation_plans", "recreation_attempts". Add-only (AGENTS.md
-- rule 18): 0001 is never edited.

CREATE TABLE recoverable_entries (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL,
  source_entry_id        TEXT NOT NULL,
  owner_id               TEXT NOT NULL,
  detected_at            TEXT NOT NULL,
  source_json            TEXT NOT NULL,
  lifecycle_state        TEXT NOT NULL CHECK (
    lifecycle_state IN ('IDLE', 'RECREATING', 'RECREATED', 'FAILED', 'AMBIGUOUS', 'DISMISSED')
  ),
  claim_token            TEXT,
  claim_expires_at       TEXT,
  new_entry_id           TEXT,
  recreated_at           TEXT,
  recreated_by           TEXT,
  -- Lineage (docs/06 "Lineage"). ON DELETE SET NULL: the uninstall cascade deletes every row for
  -- a workspace in one statement per table: SQLite's immediate FK check on a same-statement
  -- self-reference is order-dependent unless the engine resolves the ON DELETE action itself,
  -- which SET NULL does regardless of row order (the parent row's removal nulls every child's
  -- reference before the constraint is evaluated).
  parent_recoverable_id  TEXT REFERENCES recoverable_entries(id) ON DELETE SET NULL,
  UNIQUE(workspace_id, source_entry_id)
);

-- Double-adoption guard (docs/07 §8, docs/08).
CREATE UNIQUE INDEX recoverable_entries_new_entry_id_uq
  ON recoverable_entries(workspace_id, new_entry_id)
  WHERE new_entry_id IS NOT NULL;

CREATE INDEX recoverable_entries_owner_idx ON recoverable_entries(workspace_id, owner_id);
CREATE INDEX recoverable_entries_detected_idx ON recoverable_entries(workspace_id, detected_at);

CREATE TABLE recreation_plans (
  id                     TEXT PRIMARY KEY,
  recoverable_entry_id   TEXT NOT NULL REFERENCES recoverable_entries(id) ON DELETE CASCADE,
  created_by             TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  source_hash            TEXT NOT NULL,
  -- The choices this plan was built from (docs/07 §7 revalidation reruns preflight with the
  -- identical choices). Not in docs/08's original column list; added here because revalidation
  -- is not implementable without it — an implicit gap in the documented schema, not a redesign.
  choices_json           TEXT NOT NULL,
  resolution_json        TEXT NOT NULL,
  planned_request_json   TEXT NOT NULL,
  warnings_json          TEXT NOT NULL,
  blockers_json          TEXT NOT NULL,
  action_required_json   TEXT NOT NULL,
  fidelity               TEXT NOT NULL CHECK (fidelity IN ('FULL', 'ADJUSTED', 'PARTIAL', 'IMPOSSIBLE')),
  status                 TEXT NOT NULL CHECK (status IN ('ACTIVE', 'STALE', 'CONSUMED'))
);

-- At most one ACTIVE plan per entry (docs/08 invariant 3).
CREATE UNIQUE INDEX recreation_plans_active_uq
  ON recreation_plans(recoverable_entry_id)
  WHERE status = 'ACTIVE';

CREATE INDEX recreation_plans_entry_idx ON recreation_plans(recoverable_entry_id);

CREATE TABLE recreation_attempts (
  id                     TEXT PRIMARY KEY,
  plan_id                TEXT NOT NULL REFERENCES recreation_plans(id) ON DELETE CASCADE,
  recoverable_entry_id   TEXT NOT NULL REFERENCES recoverable_entries(id) ON DELETE CASCADE,
  started_at             TEXT NOT NULL,
  finished_at            TEXT,
  outcome                TEXT CHECK (outcome IS NULL OR outcome IN ('SUCCESS', 'FAILED', 'AMBIGUOUS')),
  new_entry_id           TEXT,
  error_status           INTEGER,
  error_code             TEXT,
  error_message          TEXT,
  baseline_json          TEXT,
  reconcile_json         TEXT,
  diff_json              TEXT
);

CREATE INDEX recreation_attempts_entry_idx ON recreation_attempts(recoverable_entry_id);
