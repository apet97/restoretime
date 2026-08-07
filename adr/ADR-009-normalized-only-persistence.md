# ADR-009 — Persist the normalized source only

- Status: accepted 2026-08-08
- Context: The webhook payload embeds more than recovery needs (project estimates, color,
  memberships, rate objects). Deleted entry text can hold sensitive business data. The payload is
  an external contract that must not leak into application code.
- Decision: Normalize once at the boundary into `DeletedTimeEntry` (docs/06) and persist only
  that. The raw payload is discarded after normalization. Normalization is pinned by contract tests
  against the sanitized campaign fixtures (CT-01…CT-05).
- Consequences: If a future feature needs another payload field, extend the model and the guard and
  add a fixture — do not start hoarding raw payloads. Debuggability comes from structured logs of
  IDs/states and from the fixtures, not from retained payloads.
- Evidence: docs/01 W1, W6; N3; advisor note on retaining source data (satisfied: the normalized
  source is retained; only unused fields are dropped).
