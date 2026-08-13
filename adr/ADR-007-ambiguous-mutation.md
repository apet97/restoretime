# ADR-007 — Ambiguous-mutation protocol

- Status: accepted 2026-08-08 (revised after adversarial review)
- Context: Clockify creates have no idempotency key; identical creates always succeed with new IDs
  (R7). A create can commit while its response is lost. The per-user list has no created-at field
  (W14), and legitimate look-alike entries exist (R10).
- Decision: On 5xx, any 3xx or unrecognized HTTP response, timeout, reset, or other unknown write
  classification, the attempt becomes AMBIGUOUS. Before the create, the attempt
  records a baseline snapshot of the owner's matching entries. Reconciliation compares a fresh list
  against the baseline (baseline-delta, fingerprint match). Exactly one delta → adopt (guarded by
  `UNIQUE(workspace_id, new_entry_id)`). Zero deltas after a bounded window (≥3 checks over ~10
  minutes) → the user may mark "not created" (→ IDLE) — never automatic. Two or more → the user
  picks from candidates. The create is never retried automatically; nothing in Clockify is ever
  deleted by the addon.
- Consequences: FAILED is reachable only from a definitive 4xx (validation is atomic, R3), never
  from an empty reconcile alone. Reconcile runs inline once, then lazily on detail views and
  "Check now" (ADR-010).
- Revision 2026-08-08 (round-2 live probes): the reconcile read is the **description-filtered**
  per-user list (unfiltered-list fallback), never the `start`/`end`-windowed query — the windowed
  variant was proved unreliable for fresh entries (invisible >45 s), while description-filtered
  and unfiltered lists reflect creates immediately (R10). Baseline-delta is unchanged.
- Evidence: docs/01 R7, R10, W14; advisor review 2026-08-08 (read-after-write visibility hole in
  the naive "0 matches → FAILED" rule; double-adoption hole — both fixed here).
