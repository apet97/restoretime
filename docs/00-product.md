# 00 — Product

## What the product does

RestoreTime is a Clockify Marketplace add-on. When a user deletes a time entry, RestoreTime keeps a
copy of the deleted entry's data. The user can then **recreate** the entry: RestoreTime creates a
**new** time entry with the same user-controlled values.

There is no native restoration in Clockify. The deleted entry and the recreated entry are different
entities with different IDs.

```text
Deleted entry A  ──►  RestoreTime recreates  ──►  New entry B (new ID)
```

## Terminology (mandatory)

Use: **Recovery, Recreate, Recreation, Recreated, Deleted entry, New entry.**

Never use: "restore", "restored", "undelete", "native restore", "same entry", except when quoting
Clockify documentation about unrelated behavior.

## Users

### Regular user

A regular user can:

- see only deleted entries that the user owned;
- check if a deleted entry can be recreated;
- see which values the new entry will keep and which will change;
- resolve missing dependencies when the product offers a choice (for example, select a replacement
  project);
- recreate the user's own eligible deleted entries.

### Workspace admin or owner

An admin can also:

- see recoverable deleted entries for the full workspace;
- filter by user, project, date, and status;
- recreate eligible entries for other users;
- use bulk recreation for multiple entries.

All permission checks run on the server. The UI never decides what a user may see or do.

## What recreation preserves

Preserved exactly (evidence: docs/01, W-series/R-series):

- description;
- start and end time;
- project, task, and tags (if they still exist);
- billable flag (subject to workspace permissions);
- custom-field values (when the field still exists; the value is written at creation, R5);
- running state (as an explicit user choice).

Restrictions the product enforces: only `REGULAR` entries are recreated (never breaks, time off,
or holidays). In force-timer workspaces and locked periods, regular users are blocked — an admin
can recreate the entry instead (admins bypass both restrictions).

Always different on the new entry (system differences):

- new time entry ID;
- new creation timestamp and audit history;
- approval: the new entry is not part of any approval request. (Approved entries cannot be deleted
  in Clockify, so approval state can never be lost by deletion — evidence R9);
- no link to any invoice;
- rates: Clockify applies the rates that are current at recreation time;
- custom fields: values that existed on the deleted entry are written to the new entry when the
  field still exists. A field that was removed, or a dropdown option that no longer exists, cannot
  be preserved — the product warns and asks before it drops anything.

The UI states these differences before the user confirms a recreation.

## Product principles

1. **No silent changes.** The product never changes a value without telling the user. It preserves,
   asks, warns, or blocks.
2. **Honest uncertainty.** If the product cannot confirm whether Clockify created an entry, it says
   so. It never guesses.
3. **One source of truth.** The deletion webhook is the only source of deleted-entry data.
4. **Least data.** The product stores only the data that recovery needs.
