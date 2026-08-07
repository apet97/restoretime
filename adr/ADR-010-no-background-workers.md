# ADR-010 — No background workers

- Status: accepted 2026-08-08
- Context: Two designs looked like they needed a daemon: AMBIGUOUS reconciliation polling, and
  RECREATING lease sweeping.
- Decision: Neither exists as a process. Reconcile runs once inline when the ambiguity occurs,
  then lazily — at most once per 30 s when someone views the entry, and on an explicit "Check now".
  Lease expiry is enforced inside the claim predicate (`OR claim_expires_at < now`), so any new
  attempt reclaims a wedged one; nothing sweeps.
- Consequences: AMBIGUOUS rows with no viewers make no progress until someone looks — acceptable
  and honest, because resolution requires a user decision anyway in the zero- and multi-match
  cases. One process total; operations stay at docs/14 scale.
- Evidence: docs/07 §6, §8; advisor review (lease/fencing requirement — implemented in the claim
  design).
