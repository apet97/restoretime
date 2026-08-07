# ADR-006 — Immutable recreation plans with pre-mutation revalidation

- Status: accepted 2026-08-08
- Context: Preflight resolves current workspace state (project, task, tags, owner, settings). That
  state can change between the user reading the plan and confirming it (TOCTOU). Silent execution
  of a stale plan violates the no-silent-changes invariant.
- Decision: A preflight produces an immutable `RecreationPlan` row (source hash, resolved
  dependencies, exact planned request, warnings, blockers, fidelity). Confirm revalidates the
  mutable dependencies; any difference marks the plan STALE and produces a fresh plan. Only an
  ACTIVE plan whose revalidation passes can execute, exactly once (CONSUMED).
- Consequences: Plans are persisted (audit + revalidation anchor). Old plans are STALE, not
  deleted. Execution always re-checks permission with the confirmer's fresh claims.
- Evidence: docs/07 §5–§7; R3 (server-side atomic validation is the backstop).
