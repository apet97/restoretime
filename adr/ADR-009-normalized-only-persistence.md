# ADR-009 — Persist the normalized source only

- Status: accepted 2026-08-08; recovery-record inventory clarified 2026-08-13
- Context: The webhook payload embeds more than recovery needs (project estimates, color,
  memberships, rate objects). Deleted entry text can hold sensitive business data. The payload is
  an external contract that must not leak into application code.
- Decision: Normalize once at the boundary into `DeletedTimeEntry` (docs/06). Discard the raw
  payload after normalization. Persist the normalized source and only the derived recovery records
  in docs/08: plans, attempts, lifecycle state, lineage, and installation data. A plan can contain
  the exact planned request, user choices, current labels, and a preview value. It must not create a
  second copy of source custom-field values in `presentation_json`. Contract tests pin
  normalization against the sanitized campaign fixtures (CT-01…CT-05).
- Consequences: If a future feature needs another payload field, extend the model and the guard and
  add a fixture — do not start hoarding raw payloads. Debuggability comes from structured logs of
  IDs/states and from the fixtures, not from retained payloads.
- Evidence: docs/01 W1, W6; N3; advisor note on retaining source data (satisfied: the normalized
  source is retained; only unused fields are dropped).
