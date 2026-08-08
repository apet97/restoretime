# AGENTS.md — repository rules for coding agents

## What this product is

RestoreTime **recreates** deleted Clockify time entries. It never restores them. A recreated entry
always has a new identity (new ID, new timestamps, never part of any approval request or invoice,
current rates).

## Non-negotiable rules

1. Use evidence-backed platform behavior. `docs/01-evidence-baseline.md` facts marked `PROVED*` are
   settled. Do not re-litigate them without new live evidence; record new evidence in `evidence/`.
2. Do not use `/entities/deleted`, `/entities/created`, or `/entities/updated`. ADR-002 bans them.
3. Use `@apet97/clockify-addon-sdk` for all addon platform boundaries (manifest, verification,
   lifecycle, installation storage contract, token encryption, iframe bridge, secure responses).
4. Use `clockify-sdk-ts-115` for all Clockify REST operations.
5. Do not duplicate SDK behavior. Do not wrap SDK calls in app-level abstractions that add no
   behavior. Do not work around an SDK defect in app code — report it as a blocking dependency.
6. Never expose workspace-wide deleted data to regular users. List queries filter by
   `owner_id = viewer` for non-admins.
7. Enforce permissions server-side on every request, from verified component claims only. Identity
   never comes from path, query, or body.
8. Never silently alter source values: no owner, project, task, tag, custom-field, description,
   time, duration, billable, or timezone changes without an explicit user choice or a shown
   warning.
9. Every Clockify mutation originates from a current valid `RecreationPlan`. Revalidate mutable
   dependencies immediately before the mutation. A STALE plan never executes.
10. Never blindly retry an ambiguous Clockify write. Follow ADR-007.
11. Prevent duplicate recreation with database invariants (`UNIQUE` + atomic claim), not UI state.
12. Escape all Clockify-controlled user content before rendering. No `innerHTML` with interpolated
    values.
13. Minimize persisted deleted data: the normalized source only. Never log webhook bodies,
    descriptions, custom-field values, or tokens.
14. On uninstall, hard-delete the workspace's data in one transaction.

## Engineering rules

15. No abstraction without a concrete requirement. No dead code. No unused dependencies. No
    speculative features. The dependency list (`implementation/DEPENDENCIES.md`) is closed.
16. Prefer simple readable code over clever code. A human and an AI agent must both be able to
    maintain it.
17. No background workers, job queues, caches, or second services (ADR-010).
18. Migrations are add-only SQL files; never edit an applied migration.
19. Tests defend observable contracts (docs/13). Do not write coverage-padding tests. Do not delete
    or weaken a failing test; fix the cause or record the blocker.
20. User-facing text follows ASD-STE100-informed Simplified Technical English: short active
    sentences, one term per concept, explicit conditions. Use the mandated terminology
    (recreate/recreation/recreated; deleted entry; new entry; never restore/undelete).

## Harness rules for implementation agents

- Apply the `asd-ste100` skill to all user-facing text and documentation.
- Apply the `self-improvement` skill when debugging, refactoring, or extending: prefer the weakest
  valid hypothesis that covers the evidence; do not special-case inputs.
- Do not load other skills unless the operator explicitly routes them.

## Repository facts

- Node `>=22.13.0`, TypeScript strict. SQLite via `better-sqlite3`.
- Source SDKs are read-only neighbors of this repo (paths and pinned commits in `IMPLEMENTER.md`).
- Secrets live in the environment only. The repo must never contain credentials.
