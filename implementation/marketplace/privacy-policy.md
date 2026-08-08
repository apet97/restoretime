# Privacy text (docs/15 "Privacy text: what is stored (docs/08), uninstall purge behavior (F17),
no raw payload retention (ADR-009)")

Written for the Marketplace review and for end users (workspace admins deciding whether to
install). Simplified Technical English throughout; every claim below cites the code or doc that
makes it true, not aspiration.

## What RestoreTime stores

When a time entry is deleted, RestoreTime keeps a copy of these fields in its own database (one
row per deleted entry, docs/08 `recoverable_entries`):

- who owned the entry, and who deletes/recreates it later
- the entry's description, start and end time, billable flag, and time zone
- the entry's project, task, tags, and custom-field values, **if the deletion webhook carried
  them** — a normalized copy, not the raw event
- when RestoreTime received the deletion event
- the recovery status of the entry (needs a decision, recreating, recreated, failed, etc.) and, if
  recreated, the new entry's ID

RestoreTime never stores:

- the deleted entry's pay rate or cost rate (ADR-009 — discarded at normalization, even though the
  webhook may carry them)
- the raw webhook payload Clockify sends (only the normalized fields above; docs/08 invariant 5)
- any data about entries that were never deleted
- Clockify session cookies (there are none — every request is a short-lived, independently
  verified signed token, docs/12 boundary 2)

## Installation data

RestoreTime stores one installation record per workspace: the workspace ID, the installation's
Clockify API access token, and the webhook delivery token Clockify assigns. The access token is
encrypted at rest (AES-256-GCM, keyed by the deployment's `TOKEN_ENCRYPTION_KEY`) and is never
returned in any API response or written to a log line (docs/12 "Data protection"; verified by an
automated test that captures every log line a full product run produces and asserts no token ever
appears in one — `tests/integration/log-audit.test.ts`).

## What an admin sees vs. a regular user

A regular user sees and can recreate only the deleted entries they themselves owned. A workspace
admin or owner can see and recreate any workspace member's deleted entries. This split is enforced
on the server for every request, from the verified Clockify session token only — never from
anything the browser sends that could be edited (docs/09 "Permissions").

## Logging

RestoreTime's logs contain IDs, status values, and error codes — never a deleted entry's
description, its custom-field values, or any authentication token (docs/14 "Logging"). This is
enforced by the same automated log-content test named above.

## Retention

A deleted entry's copy stays in RestoreTime's database until it is recreated, dismissed, or the
addon is removed from the workspace. RestoreTime has no separate expiry timer — the copy's
lifetime tracks the recovery decision, not a clock (docs/08 "Retention and deletion").

## Uninstalling

Removing RestoreTime from a workspace deletes every row RestoreTime holds for that workspace —
the installation record and every deleted-entry copy — in one operation, immediately (docs/08 F17,
verified by `tests/integration/uninstall.test.ts`). Nothing is kept "in case you reinstall."
Disabling the addon (without uninstalling) is different: it keeps the data, because the addon can
be re-enabled.

## Data RestoreTime never touches

RestoreTime only ever creates a **new** time entry through its own recreation feature. It never
edits, deletes, or reads entries beyond what preflight needs to check (project/task/tag/custom
field existence) and what verification needs to confirm a create (docs/00 "Product principles").
