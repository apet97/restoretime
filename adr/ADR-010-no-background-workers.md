# ADR-010 — No background workers

- Status: accepted 2026-08-08; recovery detail amended 2026-08-10
- Context: Two designs looked like they needed a daemon: AMBIGUOUS reconciliation polling, and
  RECREATING lease sweeping.
- Decision: Neither exists as a process. Reconcile runs once inline when the ambiguity occurs,
  then lazily — at most once per 30 s when someone views the entry, and on an explicit "Check now".
  Lease recovery runs when someone opens the detail view or when a new claim checks an expired
  `RECREATING` row. A new claim replaces an expired token only when no durable attempt exists. If
  an attempt exists, recovery projects its stored final outcome or changes the row to `AMBIGUOUS`;
  it does not start another attempt. Nothing sweeps.
- Consequences: AMBIGUOUS rows with no viewers make no progress until someone looks — acceptable
  and honest, because resolution requires a user decision anyway in the zero- and multi-match
  cases. One process total; operations stay at docs/14 scale.
- Evidence: docs/07 §6, §8; advisor review (lease/fencing requirement — implemented in the claim
  design).
