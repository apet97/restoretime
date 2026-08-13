# Privacy notice source text

Written for the Marketplace review and for workspace admins who decide whether to install the
add-on. The text uses ASD-STE100-informed clear English. Every claim below maps to current behavior
or to identified historical evidence.

## What RestoreTime stores

When a time entry is deleted, RestoreTime keeps a copy of these fields in its own database (one
row per deleted entry, docs/08 `recoverable_entries`):

- the workspace, internal recovery, and deleted source-entry IDs
- the owner's ID and name, and the ID of the user who later recreates the entry
- the description, start and end time, billable flag, time zone, running state, and entry type
- the project ID and name, client name, task ID and name, tag IDs and names, and custom-field IDs,
  names, and values, **if the deletion webhook carried them**
- when RestoreTime received the event, the recovery status, claim timing and fencing ID, the new
  entry ID and recreation time, and same-owner recreation lineage

RestoreTime never stores:

- the deleted entry's pay rate or cost rate (ADR-009 — discarded at normalization, even though the
  webhook may carry them)
- the raw webhook payload Clockify sends (only the normalized fields above; docs/08 invariant 5)
- who deleted the entry — Clockify's deletion event carries the entry's owner, never the actor
  who deleted it (docs/01 W13), so RestoreTime has no deleted-by data to store or show
- a full copy of entries that were never deleted. Ambiguity checks can retain IDs for live entries
  that matched a recreation fingerprint, and a successful attempt retains the new entry ID and
  verification differences
- Clockify session cookies (there are none — every request is a short-lived, independently
  verified signed token, docs/12 boundary 2)

## Installation data

RestoreTime stores one record per workspace and add-on installation. It contains the workspace and
add-on IDs, the add-on user and acting-user IDs, the Clockify API URL, the installation status,
install and broken-token times, and the configured webhook paths. It also contains the Clockify API
access token and webhook delivery tokens. The SDK encrypts both token types at rest with
AES-256-GCM, keyed by the deployment's `TOKEN_ENCRYPTION_KEY`. RestoreTime never returns them in an
API response or writes them to a documented log field (docs/12 "Data protection"). An automated
test captures the exercised install, webhook, API, recreation-failure, and uninstall log paths and
asserts that no token appears (`tests/integration/log-audit.test.ts`).

## Recreation plans and attempts

Each preflight stores a plan. A plan can contain the user's choices, the exact request proposed for
the new entry, current project/task/tag/custom-field labels, preview values, warnings, blockers,
required actions, resolution outcomes, and fidelity. Plan metadata contains the internal plan and
recovery IDs, creator ID, creation time, source hash, and plan status. The presentation record must
not make a second copy of source custom-field values. A plan created before this presentation
record was added must go through a fresh preflight.

Each recreation stores an attempt record. It can contain start and finish times, the outcome, safe
Clockify error status, code, and safe user-facing reason, internal attempt/plan/recovery IDs, IDs
seen before or during ambiguity checks, reconciliation counts and times, the new entry ID, and
verification differences. Attempt records and their linked plans remain for audit until uninstall.
A preflight deletes older STALE or CONSUMED plans for that deleted entry when they have no attempt.
Baseline entry IDs and reconciliation candidate IDs remain only while an attempt is
ambiguous. RestoreTime clears that transient evidence after a definitive outcome. Uninstall
includes all remaining plans and attempts in the same workspace purge as the deleted-entry copy.

## What an admin sees vs. a regular user

A regular user sees and can recreate only the deleted entries they themselves owned. A workspace
admin or owner can see and recreate any workspace member's deleted entries. This split is enforced
on the server for every request, from the verified Clockify session token only — never from
anything the browser sends that could be edited (docs/09 "Permissions").

## Logging

RestoreTime's documented log fields contain IDs, status values, durations, and safe error fields.
The exercised log paths must not contain a deleted entry description, a custom-field value, or an
authentication token (docs/14 "Logging"). The automated test above defends those paths. Code
review and the allowed-field list defend new log paths.

## Retention

RestoreTime keeps the normalized deleted-entry copy after recreation or dismissal. These actions
change its lifecycle state but do not delete the stored source fields. RestoreTime has no separate
expiry timer. The copy remains until the add-on is removed and the uninstall lifecycle call reaches
RestoreTime (docs/08 "Retention and deletion").

Operational backups contain the same sensitive database fields. An uninstall purges the active
database. It does not rewrite backup files that already exist. The deployment operator must set
and enforce backup access and retention rules (docs/14 "Deployment").

## Uninstalling

When Clockify's `DELETED` lifecycle call reaches RestoreTime, RestoreTime hard-deletes every row it
holds for that workspace in one transaction. This includes the installation record and every
deleted-entry copy (docs/02 F17; `tests/integration/uninstall.test.ts`). A historical developer-
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

RestoreTime creates a **new** time entry through its recreation feature. It reads time entries to
verify a successful create and to resolve an unknown create result. Normal product operation does
not edit or delete an existing Clockify time entry. Release tests create and delete marked probe
entries only in a sacrificial developer workspace.
