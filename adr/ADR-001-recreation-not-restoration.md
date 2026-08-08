# ADR-001 — Recreation, not restoration

- Status: accepted 2026-08-08
- Context: Clockify has no undelete. A deleted time entry cannot be brought back; a new entry can
  be created with equivalent user-controlled values (RC consensus: `YES_WITH_LIMITATIONS`).
- Decision: The product recreates. Every artifact — UI text, API names, states, docs — says
  *recreate/recreation/recreated*, *deleted entry*, *new entry*. The new entry always has a new ID,
  new timestamps, no membership in any approval request, no invoice link, and current rates (R9).
- Consequences: Terminology is a tested invariant (docs/10, docs/16). Claims of restoration are
  release blockers.
- Evidence: docs/01 R9, R12; RC recreation-fidelity-matrix.
