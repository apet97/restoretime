# TASK-03 — Preflight engine

- Pass: PASS-02
- Goal: deterministic `RecreationPlan` from (source, current workspace, viewer, choices).
- Why: preflight is the product's core decision; it must be mechanical and pure.
- Prerequisites: TASK-02 (source rows), TASK-01 (viewer guard).
- Files/modules: `src/domain/preflight.ts`, `policy.ts`, `fidelity.ts`, `plan.ts`,
  `src/clockify/preflight-data.ts`, `src/store/plans.ts`; `POST /api/entries/preflight` (body `{entryId, choices?}`).
- Interfaces: decision rules P-* per docs/07 §3; plan shape per docs/06; lookups per docs/07 §2.
  Custom fields: request `"entity-type": ["TIMEENTRY"]` (array), active means `status !== "INACTIVE"`,
  default is `workspaceDefaultValue` (S6). Bounded reads use `iterPages` (docs/03 note 5).
- Behavior: blockers → IMPOSSIBLE; unresolved inputs → ACTION_REQUIRED with exact options;
  otherwise ACTIVE plan with `plannedRequest` and fidelity. New plan STALE-supersedes prior ones.
- Failure behavior: Clockify read failure after SDK retries → "Clockify could not be reached"
  error, no plan persisted.
- Tests: UT-P01…P16, UT-F01, UT-A01.
- Acceptance: every P-* rule has a failing-then-passing unit test; plan JSON matches docs/06.
