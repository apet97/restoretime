# RestoreTime — Time Entry Recovery for Clockify

RestoreTime is a Clockify Marketplace add-on. It recovers deleted time entries.

When a user deletes a time entry in Clockify, RestoreTime keeps the entry's data. The user can then
**recreate** the entry: RestoreTime creates a **new** time entry with the same description, time,
project, task, tags, and billable flag.

Clockify has no undelete function. The new entry is a new entity. It has a new ID, a new creation
time, and the approval state `Not submitted`. It is not linked to any invoice. Clockify applies the
rates that are current at recreation time. Custom fields on the new entry use the current workspace
defaults.

## How it works

1. Clockify sends a `TIME_ENTRY_DELETED` webhook to RestoreTime.
2. RestoreTime verifies the webhook and stores the deleted entry's data.
3. The user opens **Time Entry Recovery** in the Clockify sidebar.
4. RestoreTime checks the current workspace: does the project still exist? The task? The tags? Is
   the period locked?
5. The user sees exactly what the new entry will contain, and what must change. The user confirms.
6. RestoreTime creates the new entry and shows the result.

Regular users see their own deleted entries. Workspace admins see all entries in the workspace and
can recreate entries for other users.

## Safety rules

- RestoreTime never changes a value silently. It preserves, asks, warns, or blocks.
- RestoreTime never retries a create request whose result is unknown. If the result is unknown, the
  product says so and helps the user check.
- One deleted entry produces at most one recreated entry. This is enforced by the database, not by
  the UI.
- All permission checks run on the server.
- When a workspace uninstalls RestoreTime, the workspace's data is deleted.

## Status

This repository currently contains the **implementation blueprint**: evidence, architecture,
decisions, and runnable implementation passes. The production code is built by executing
`implementation/passes/PASS-01` through `PASS-05`. Start with `IMPLEMENTER.md`.

## Documentation map

| Path | Content |
|---|---|
| `IMPLEMENTER.md` | Entry point for implementation agents |
| `docs/00-product.md` | Product definition and terminology |
| `docs/01-evidence-baseline.md` | Proven API/webhook facts |
| `docs/05-architecture.md` | System design |
| `docs/07-recreation-preflight.md` | The core algorithm |
| `implementation/ROADMAP.md` | Pass sequence |
| `evidence/` | Evidence index and validation |
| `adr/` | Architecture decisions |

## License

MIT. See `LICENSE`.
