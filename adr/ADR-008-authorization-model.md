# ADR-008 — Authorization model

- Status: accepted 2026-08-08
- Context: The addon platform delivers verified viewer identity and workspace role in the component
  JWT (S2). The product needs exactly two access levels.
- Decision: One predicate module. Admin (`owner`/`admin` via the SDK predicate) sees and acts on
  all workspace entries; any other verified viewer reads and acts only on entries they own
  (`source.ownerId == viewer.userId`). Identity and workspace scope come only from verified claims.
- Consequences: No RBAC framework, no roles table, no client-supplied identity. Permission is
  re-evaluated on every call and again inside plan execution (fresh claims).
- Evidence: docs/09; docs/01 S2; addon SDK `isClockifyAdminRole`.
