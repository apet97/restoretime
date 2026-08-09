# 10 — UI specification

One Clockify sidebar component. Vanilla TypeScript, bundled with esbuild, served by
`createClockifyHtmlResponse`. All text follows Simplified Technical English: short sentences, one
term per concept, explicit conditions.

## Terms used in the UI

Deleted entry · New entry · Recreate · Recreated · Ready · Needs your input · Blocked · Recreating ·
Unknown result · Failed · Dismissed. Never: restore, undelete, original entry.

## 1. List view (regular user)

Title: **Deleted time entries**. Shows only the viewer's own entries.

Row content:

```text
Fri 7 Aug 2026 · 09:00–11:30 (2h 30m)
Customer Support — API investigation
Tags: support, api          Detected: 7 Aug 2026, 15:42
Status: Ready to recreate
[Recreate]
```

- Status text comes from the latest preflight summary or lifecycle state: `Ready to recreate`,
  `Needs your input`, `Blocked`, `Recreating…`, `Unknown result`, `Failed`, `Recreated`.
- "Detected" is the receipt time (W14). The UI never says "Deleted at".
- Empty state: "No deleted time entries. When you delete a time entry in Clockify, it appears
  here."
- The list is bounded server-side (50 most recently detected). Every returned row costs a preflight
  with its own Clockify lookups, so an unbounded list scales API traffic with the backlog. When rows
  were withheld the list says so — "Showing the 50 most recently detected entries. Use the filters
  above to find older ones." — rather than letting a full page read as "everything".

## 2. List view (admin additions)

Admin filters above the list: user, project, date range, status, free-text search. A "Show
dismissed" toggle. Bulk mode: row checkboxes, a counter, and one **Review selected** action.
Nothing else. No dashboards, no charts.

**User and project are filtered by name, not by id.** Nobody knows a 24-character Clockify id by
heart, so an id box is a filter nobody can use. Both inputs are free text with a `<datalist>` of
current workspace names attached (`/api/options?kind=users` and `kind=projects`, fetched in the
background — a failure leaves the suggestions empty and never delays or blocks the rows). Each kind
is fetched **once per component session**: the filter bar re-renders on every list load, and each
options kind is a `collectPaged` walk, so an uncached fetch would turn a checkbox click into a
pagination sweep of the workspace. The query params are `userName` and `projectName`; `userId` and
`projectId` still exist on the route and are the precise form.

The match is against the **name stored on the row at deletion time**, never a Clockify lookup, and
selecting a suggestion is never required. That is deliberate: a deleted project and a deactivated
member are exactly the rows this product exists for, and neither appears in any current options
list, so resolving a typed name to an id would silently fail to find them. Three consequences,
written down rather than discovered:

- **A rename in Clockify does not reach rows already stored.** An entry deleted before the rename
  keeps the old name and is found by the old name. The row genuinely records the name as it was.
- **Matching folds ASCII case only** — SQLite's built-in `LIKE`. `Ötzi` does not match `ötzi`. The
  same has always been true of the free-text description search.
- **An entry whose webhook carried no user name** (stored as `""`) is not reachable by any user
  filter; clear the filter to see it.

`userName` is admin-only for the same reason `userId` is (docs/09); so is `kind=users`, the one
options kind that enumerates people rather than workspace metadata.

## 3. Detail view

Two columns of fact, then differences.

```text
DELETED ENTRY                          NEW ENTRY (planned)
Fri 7 Aug 2026, 09:00–11:30            Fri 7 Aug 2026, 09:00–11:30
Customer Support — API investigation   Customer Support — API investigation
Project: Legacy API                    Project: Customer API   (you selected this)
Task: Investigation                    Task: —                 (task no longer exists)
Tags: support, api                     Tags: support, api
Billable: yes                          Billable: yes
Owner: Ana Markovic                    Owner: Ana Markovic
```

A **Dismiss** action sits beside "Continue to confirm" (docs/06: IDLE/FAILED → DISMISSED). Without
it the "Show dismissed" toggle in §2 has nothing to reveal and a list can only ever grow. The
inverse, **Undismiss**, is on the dismissed entry's own view.

Then a **Differences** section that always lists the system differences:

```text
The new entry always differs from the deleted entry:
- It has a new ID and a new creation time.
- It is not part of any approval request.
- It is not linked to any invoice.
- Clockify applies the rates that are current today.
```

Plus plan-specific warnings, each in the form "what changed — why — what the new entry will
contain":

```text
Custom field "Cost code" — this field no longer exists in the workspace. The deleted entry had
"AZ-104". The new entry cannot carry this value.
```

## 4. Resolution widgets (ACTION_REQUIRED)

| Case | Widget |
|---|---|
| Project gone / required | Select: current projects (name + client). Extra option "No project" only when the workspace does not require projects |
| Task gone | Select: current tasks of the effective project, plus "No task" when tasks are optional |
| Tag gone | Checkbox per missing tag: "Remove tag ‹name›". Multi-select of current tags to add, when wanted |
| Description required | Text input with the original description prefilled only if it was non-empty; otherwise empty |
| Custom field option invalid | Select: the field's current options, or "Drop this value" |
| Custom field required | Text/number input per field type |
| Running entry | Radio: "Start a running timer (start time 09:00, no end)" / "Set an end time" with a datetime input. The running option shows: "Clockify allows one running timer per user. Starting this timer stops the timer that is running now." |
| Not a regular entry (break, time off, holiday) | No widget. "Only regular time entries can be recreated." |
| Force timer on (regular user) | No widget. "This workspace only allows running timers. An admin can recreate this entry for you." |
| Locked period (regular user) | Warning, not a block: "This entry's date may be in a locked period. An admin can recreate it, or unlock the period." |
| Blocked (owner gone) | No widget. Explanation text and what to do next |

Every selection re-runs preflight (`POST /api/entries/preflight` with `{entryId, choices}`). The confirm
button activates only when the plan has no blockers and no open ACTION_REQUIRED items.

## 5. Confirm view

- The exact planned values (as in the detail view's NEW ENTRY column).
- Warnings and differences.
- Fidelity badge: **Complete** (FULL) / **Adjusted** (ADJUSTED) / **Partial** (PARTIAL).
- Primary action: **Recreate entry**. A plan older than 5 minutes is revalidated on confirm
  regardless (server-side rule, not visible).

## 6. Result views

Success:

```text
Time entry recreated.
Fidelity: Adjusted.
Differences: …
[Open in Clockify tracker]  (bridge navigate)   [Back to deleted entries]
```

Failed (nothing was created):

```text
Clockify did not create the entry.
Reason: The project "Legacy API" no longer belongs to this workspace.
Nothing was created. You can change your selections and try again.
[Try again]
```

Unknown result (AMBIGUOUS):

```text
We do not know whether Clockify created this entry. The request was sent, but Clockify's answer
did not arrive.
Do not create the entry by hand yet.
[Check now]   Last checked: 15:43:10
```

After the bounded reconcile finds nothing:

```text
We checked Clockify 3 times in 10 minutes. The entry does not appear there.
If you can see the entry in Clockify, select "It exists". Otherwise select "It was not created".
[It exists — let me pick it]   [It was not created]
```

## 7. Bulk flow (admin)

1. Select rows → **Review selected** (max 50).
2. The product runs preflight for each entry and shows one line per entry: Ready / Needs input /
   Blocked, with the reason.
3. Entries needing input are excluded and keep their state; the admin can handle them one by one.
4. **Recreate N entries** confirms once. Each entry is claimed and executed independently. Results
   list per entry: Recreated / Failed (reason) / Unknown result. There is no cross-entry
   transaction; each row shows its own outcome.

## 8. General UI rules

- Styling is a single stylesheet served at `/static/app.css`, allowed by `style-src 'self'`. Inline
  `<style>` blocks and `style=` attributes are blocked by `default-src 'none'` — the same rule that
  blocked the bundle before `script-src` and `/api/*` before `connect-src`. Colours are custom
  properties; the dark palette keys off `[data-clockify-theme="dark"]`, the attribute the SDK's
  `applyClockifyTheme` writes to the document root.
- Views mark their own intent with `rt-primary` (the one primary action), `rt-title` (a row header
  that reads as a title), and `rt-notice` (blockers and ACTION_REQUIRED). Position is not a
  substitute: inferring the primary button from `div > button:first-child` styled the list row's
  date header as a filled button, because every row child is its own `<div>`.
- All Clockify-controlled strings (descriptions, project names, tag names, user names) are escaped
  before insertion into HTML (N5). No `innerHTML` with interpolated values; use `textContent`.
- Dates display in the viewer's locale via the SDK `formatClockifyDate`; theme and language apply
  via `applyClockifyTheme`/`applyClockifyLanguage` from the verified claims.
- The iframe bridge is created with `parentOrigin` from `CLOCKIFY_PARENT_ORIGIN` (fact 12).
- Every failure view answers: what happened, whether anything was created, what to do next (N8).
- Token refresh **(proactive half verified live, evidence "Live run 12")**: the dispatch fires at
  25 minutes and the session keeps working past the original token's expiry — a call 106 s after
  expiry still succeeded. The **reactive** half (a 401 mid-call triggering one retry, and the
  session-expired notice when that retry also 401s) stays unit-covered only: the proactive refresh
  keeps it from being reached, and nothing in the platform can invalidate a token mid-session.
- Token refresh: the token lives in memory only. `bridge.subscribe("refreshAddonToken", body => ...)` receives the refreshed token as a window message whose title is `refreshAddonToken` and whose body is the token string. The shell dispatches `bridge.refreshAddonToken()` proactively every 25 minutes (tokens live 30 minutes). On API 401 the shell dispatches a refresh, waits up to 5 seconds for the message, retries the call once with the new token, and on timeout shows a session-expired notice ("Reload the component").
- Disabled addon (STATUS_CHANGED INACTIVE): a notice "RestoreTime is disabled for this workspace"
  replaces actions; lists stay readable. Note what this is actually for: Clockify removes a disabled
  add-on from its own interface — the sidebar entry disappears and `/addons/<key>` redirects away
  (verified on the developer environment, evidence "Live run 10") — so a user cannot navigate to the
  notice. It covers the iframe that was already open when the status changed. The protection that
  matters is the server-side `actionGuard` refusal, because that stale iframe can still POST.
