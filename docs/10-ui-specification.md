# 10 — UI specification

One Clockify sidebar component. Vanilla TypeScript, bundled with esbuild, served by
`createClockifyHtmlResponse`. All text follows Simplified Technical English: short sentences, one
term per concept, explicit conditions.

## Terms used in the UI

Deleted entry · New entry · Recreate · Recreated · Ready · Needs your input · Blocked · Recreating ·
Result uncertain · Failed · Dismissed. Never: restore, undelete, original entry.

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
  `Needs your input`, `Blocked`, `Recreating…`, `Result uncertain`, `Failed`, `Recreated`.
- "Detected" is the receipt time (W14). The UI never says "Deleted at".
- Empty state: "No deleted time entries. When you delete a time entry in Clockify, it appears
  here."
- A "Show dismissed" toggle lets the viewer find and undismiss an entry that they dismissed.
- The list is paged server-side, 50 rows at a time. Every returned row costs a preflight with its
  own Clockify lookups, so an unbounded list scales API traffic with the backlog.
- When more rows exist, the list says how many are shown and offers **Load more**, which appends
  the next page and keeps the rows already on screen. Narrowing the filters is a way to search, not
  a way to paginate: every matching row has to be reachable without one. Changing a filter starts a
  fresh sequence, because the continuation token names a position in one ordered result set.
- Bulk selection survives Load more — it is keyed by row id, and the appended page only adds rows.

## 2. List view (admin additions)

Admin filters above the list: user, project, date range, status, and free-text search. Bulk mode:
row checkboxes, a counter, and one **Review selected** action. Nothing else. No dashboards, no
charts. The common "Show dismissed" control from §1 remains available.

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

**Enter in any filter field applies the filters** — the same as selecting **Apply filters**. An
Enter that confirms an IME composition is text entry, not a command, and does not apply.

**Status and "Show dismissed" are alternatives, not filters that stack.** `DISMISSED` is a
lifecycle state, so the toggle selects one state and the dropdown selects any other — they answer
the same question about the same column. Turning the toggle on therefore clears the chosen status
and disables the dropdown, and the dropdown's value is not read while it is disabled. The server
resolves the pair the same way if one ever arrives anyway (`dismissed` wins, because reaching a
category the default hides is its only purpose), so a hand-written query gets a coherent answer
too. Neither may produce `lifecycle_state = 'FAILED' AND lifecycle_state = 'DISMISSED'`, which
matches nothing and reads to an admin as "no such entries exist" — the same lie the route already
refuses to tell for an unrecognized `status` (docs/09).

### Session-local list state

The component keeps list filters, bulk mode, and selected deleted-entry IDs for one component
session. It does not put this state in the URL, storage, or the server.

- List → detail → Back keeps the filters, bulk mode, and selection.
- Applying a different filter, changing the dismissed toggle, or turning bulk mode off clears the
  selection. The component announces that change.
- **Clear filters** clears the user, project, date, status, and description-search filters. It does
  not change **Show dismissed** or bulk mode. It clears the selection only when it changes an
  applied filter.
- Bulk review uses the same selected-ID set as the list. Returning from detail runs bulk preflight
  again before it enables recreation.
- The browser never treats retained list data as current Clockify fact. It reads preflight and
  lifecycle facts from the server again when an action needs them.

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

The planned cell has a visible changed marker when structured facts differ. Its accessible label
says that the planned value changed. Placeholder text never determines absence.

A **Dismiss** action sits beside "Continue to confirm" (docs/06: IDLE/FAILED → DISMISSED). Without
it the "Show dismissed" toggle in §2 has nothing to reveal and a list can only ever grow. The
inverse, **Undismiss**, is on the dismissed entry's own view.

If the entry is part of a recreation chain, the detail view shows **Recreation chain** with
**Open previous deleted entry** and **Open next deleted entry** actions as applicable. The server
returns only related entries that the viewer can read. The browser does not infer access.

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
The custom field "Cost code" no longer exists. The deleted entry had "AZ-104". This value is not
sent.
```

## 4. Resolution widgets (ACTION_REQUIRED)

| Case | Widget |
|---|---|
| Project gone / required | Select: current projects by name, with the archived flag when applicable. Extra option "No project" only when the workspace does not require projects |
| Task gone | Select: current tasks of the effective project, plus "No task" when tasks are optional |
| Tag gone | Checkbox per missing tag: "Remove tag ‹name›". A labeled checkbox group of current tags to add, when wanted |
| Description required | Text input with the original description prefilled only if it was non-empty; otherwise empty |
| Custom field option invalid | Select: the field's current options, or "Drop this value" |
| Custom field required | Text/number input per field type |
| Running entry | Radio: "Start a running timer (start time 09:00, no end)" / "Set an end time" with a datetime input. The running option shows: "Clockify allows one running timer per user. Starting this timer stops the timer that is running now." |
| Not a regular entry (break, time off, holiday) | No widget. "Only regular time entries can be recreated." |
| Force timer on (regular user) | No widget. "This workspace only allows running timers. An admin can recreate this entry for you." |
| Locked period (regular user) | Warning, not a block: "This entry's date may be in a locked period. An admin can recreate it, or unlock the period." |
| Blocked (owner gone) | No widget. Explanation text and what to do next |

Every selection re-runs preflight (`POST /api/entries/preflight` with `{entryId, choices}`). The
component updates only the plan region. It keeps the detail heading and deleted-entry facts mounted.
It moves focus to the equivalent resolution control, or to the first unresolved control if the old
control no longer exists. The confirm button activates only when the server plan has no blockers and
no open ACTION_REQUIRED items.

Current tags and `DROPDOWN_MULTIPLE` custom-field values use native labeled checkboxes in a bounded
vertical list. The list shows a selected-value summary. Single-value fields keep native selects.

## 5. Confirm view

- The exact planned values (as in the detail view's NEW ENTRY column).
- Warnings and differences.
- Fidelity badge: **Complete** (FULL) / **Adjusted** (ADJUSTED) / **Partial** (PARTIAL).
- FULL means: "All supported values from the deleted entry are included." ADJUSTED means: "The new
  entry includes the choices you made during review." PARTIAL means: "Some values from the deleted
  entry cannot be included. Review the differences below."
- Before the primary action, the view says: "RestoreTime will create one new time entry in Clockify
  with these values. The deleted entry's history stays unchanged."
- Primary action: **Recreate entry**. Every confirm revalidates the plan server-side (docs/07 §7),
  regardless of the plan's age (not visible). There is no age threshold.

## 6. Result views

Success:

```text
Time entry recreated.
This is a new entry. It does not share the deleted entry's historical identity.
Fidelity: Adjusted.
Clockify saved a different start time: …
[Open in Clockify tracker]  (bridge navigate)   [Back to deleted entries]
```

Failed (nothing was created):

```text
Clockify did not create the entry.
Reason: The project "Legacy API" no longer belongs to this workspace.
Nothing was created. Review a new plan before you recreate the entry.
[Review a new plan] [Back to entry] [Back to deleted entries]
```

Result uncertain (AMBIGUOUS):

```text
We do not know whether Clockify created this entry. The recreation might have reached Clockify,
but RestoreTime did not get a clear result.
Do not create the entry by hand yet.
[Check now]   Last checked: 15:43:10
```

After the bounded reconcile finds nothing:

```text
We checked Clockify N times. The entry does not appear there.
If you can see the entry in Clockify, select "It exists". Otherwise select "It was not created".
[It exists — let me pick it]   [It was not created]
```

When a bounded check finds possible matches, each card is named `Possible match N`. It shows the
planned description, start, end, project, and task when available. It says: "This entry matched the
planned recreation during the last check." The card can show a short technical reference. A closed
`Show full technical reference` disclosure contains the full ID. The primary action is `Use this
match`.

Manual recovery remains available. The view explains where to find the entry ID in Clockify before
it shows a labeled manual-ID field. The field is not stored by the browser. The server still checks
the fingerprint, baseline, owner, state, and uniqueness before it accepts the ID.

## 7. Bulk flow (admin)

1. Select rows → **Review selected** (max 50).
2. The product runs preflight for each entry. A row status is Ready, Needs your input, Needs
   individual review, Blocked, Error, State changed, or Not found. Each row owns its status,
   message, and available action.
3. Only Ready rows can be recreated. Other rows keep their status. An admin can open a row when it
   gives an **Open** action.
4. **Recreate N entries** confirms once. Each entry is claimed and executed independently. Results
   list per entry: Recreated / Failed (reason) / Result uncertain. There is no cross-entry
   transaction; each row shows its own outcome.
   The request executes entries sequentially to stay within Clockify's request rate.

The review gives one summary:

- No selected rows: "No entries are selected. Select one or more ready entries to recreate."
- Selected rows with none ready: "No selected entries are ready to recreate. Review the status and
  message for each selected entry below."
- One or more ready rows: "N of M selected entries are ready to recreate."

The review introduction is: "Ready entries can be recreated in this review. Review the status and
message for each other entry."

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
- The persistent shell has one product H1, `RestoreTime`. Each complete screen has one H2. A polite
  live region announces the loaded screen. The component focuses the H2 after a complete screen
  change. Plan-region changes keep focus in the current control group.
- Button actions use visible progress labels and `aria-busy`. They reject a second immediate
  activation. The labels are `Dismissing…`, `Undismissing…`, `Preparing review…`, `Recreating…`,
  `Recreating entries…`, `Checking…`, `Updating status…`, and `Linking entry…`. A plan-region
  choice uses `Checking choices…`. A busy button, a loading placeholder, and an inline status also
  show `rt-busy-spinner`, a CSS-only spinner that `prefers-reduced-motion` switches off.
- Button-action errors stay in the current screen. Each error has alert semantics and an explicit
  safe next action such as `Reload list`, `Recheck entry`, `Check choices again`, or `Reload
  review`. Error text never exposes an HTTP status or an arbitrary response body.
- Status pills contain text. Blockers use danger treatment, warnings use warning treatment,
  system differences use information treatment, and confirmed success uses success treatment.
  Color never carries the meaning by itself.
- The document must not scroll horizontally. User-controlled text wraps. The comparison table keeps
  its labeled local horizontal scroll wrapper. Action groups stack below 600 px.
- Token refresh **(proactive half verified live, evidence "Live run 12")**: the dispatch fires at
  25 minutes and the session keeps working past the original token's expiry — a call 106 s after
  expiry still succeeded. The **reactive** half (a 401 mid-call triggering one retry, and the
  session-expired notice when refresh fails) is covered by token-authority unit tests and a
  `happy-dom` action-path test. The proactive refresh keeps this path uncommon in live use.
- Token refresh: the token lives in memory only. `bridge.subscribe("refreshAddonToken", body => ...)` receives the refreshed token as a window message whose title is `refreshAddonToken` and whose body is the token string. The shell dispatches `bridge.refreshAddonToken()` proactively every 25 minutes (tokens live 30 minutes). On API 401 the shell dispatches a refresh, waits up to 5 seconds for the message, retries the call once with the new token, and on timeout shows a session-expired notice ("Reload the component").
- Disabled addon (STATUS_CHANGED INACTIVE): a notice "RestoreTime is disabled for this workspace"
  replaces actions; lists stay readable. Note what this is actually for: Clockify removes a disabled
  add-on from its own interface — the sidebar entry disappears and `/addons/<key>` redirects away
  (verified on the developer environment, evidence "Live run 10") — so a user cannot navigate to the
  notice. It covers the iframe that was already open when the status changed. The protection that
  matters is the server-side `actionGuard` refusal, because that stale iframe can still POST.
- Broken installation (401 code 4017, docs/03 §6): the list view shows a notice — "RestoreTime is
  no longer connected to this workspace. Ask a workspace admin to reinstall this add-on, then reload
  RestoreTime." — from the `broken` flag on `GET /api/entries` (`broken_at` read back, IT-08 records
  it). The rows stay readable: a rejected token blocks Clockify calls, not stored data. Broken,
  disabled, and currently unavailable installations show stored facts but no Clockify-dependent
  action. On every other surface the 4017 maps to the same reinstall guidance. It never says to try
  again in a moment because a rejected token does not recover on its own.
