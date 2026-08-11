# Privacy text (docs/15 "Privacy text: what is stored (docs/08), uninstall purge behavior (F17),
no raw payload retention (ADR-009)")

Written for the Marketplace review and for workspace admins who decide whether to install the
add-on. The text uses ASD-STE100-informed clear English. Every claim below maps to current behavior
or to identified historical evidence.

## What RestoreTime stores

When a time entry is deleted, RestoreTime keeps a copy of these fields in its own database (one
row per deleted entry, docs/08 `recoverable_entries`):

- who owned the entry, and who recreates it later
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
- who deleted the entry — Clockify's deletion event carries the entry's owner, never the actor
  who deleted it (docs/01 W13), so RestoreTime has no deleted-by data to store or show
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

RestoreTime keeps the normalized deleted-entry copy after recreation or dismissal. These actions
change its lifecycle state but do not delete the stored source fields. RestoreTime has no separate
expiry timer. The copy remains until the add-on is removed and the uninstall lifecycle call reaches
RestoreTime (docs/08 "Retention and deletion").

## Uninstalling

When Clockify's `DELETED` lifecycle call reaches RestoreTime, RestoreTime hard-deletes every row it
holds for that workspace in one transaction. This includes the installation record and every
deleted-entry copy (docs/08 F17; `tests/integration/uninstall.test.ts`). A historical developer-
environment run also observed an uninstall purge of 132 rows (evidence "Live run 10"). No workspace
row remains after that transaction commits.

One qualification applies: the deletion is triggered by Clockify calling RestoreTime's `DELETED`
lifecycle endpoint. If RestoreTime's host is unreachable at that moment, the call cannot arrive and
the data is not deleted then — Clockify still removes the add-on on its side, so the two can
disagree. A historical developer-environment run observed this condition (evidence "Live run 11").
An operator whose host was down during an uninstall should confirm that the purge ran or delete that
workspace's rows directly. Disabling the add-on without uninstalling it keeps the data because the
add-on can be re-enabled.

## Data RestoreTime never touches

RestoreTime only ever creates a **new** time entry through its own recreation feature. It never
edits, deletes, or reads entries beyond what preflight needs to check (project/task/tag/custom
field existence) and what verification needs to confirm a create (docs/00 "Product principles").
