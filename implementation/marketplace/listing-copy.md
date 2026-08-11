# Marketplace listing copy

This file contains paste-ready text. It does not prove a production deployment, a Marketplace
submission, or approval of legal and contact details.

## Copy counts

Counts use Unicode code points and include spaces and punctuation. The long-description count also
includes the 10 line-feed characters between its six paragraphs.

| Field | Count | Limit | Result |
|---|---:|---:|---|
| Tagline | 26 characters | Portal limit not recorded | Ready as text |
| Short description | 119 characters | 140 characters | Within limit |
| Long description | 1,482 characters | 1,500 characters | Within limit |
| Support summary | 147 characters | Portal limit not recorded | Ready as text |

## Core fields

| Field | Paste-ready value | Status |
|---|---|---|
| Name | RestoreTime — Time Entry Recovery | Matches the manifest |
| Tagline | Review. Confirm. Recreate. | Text ready |
| Short description | See “Short description” below | 119/140 characters; text ready |
| Long description | See “Long description” below | 1,482/1,500 characters; text ready |
| Support summary | See “Support summary” below | 147 characters; text ready |
| Category | Productivity | Candidate; confirm the exact portal category name |
| Secondary category, if supported | Time tracking | Candidate; confirm the portal taxonomy |
| Intended users | Clockify users who need to recreate deleted time entries; workspace owners and admins can also work across the workspace | Text ready |
| Minimum Clockify plan | Free | Matches `minimalSubscriptionPlan` in the manifest |
| Website URL | `<production PUBLIC_BASE_URL>` | Production host not supplied |
| Support URL | `<public support URL>` | Public URL not supplied |
| Support contact | `<monitored support contact>` | Contact not supplied |
| Privacy URL | `<public privacy URL>` | The source text exists in `privacy-policy.md`; public URL not supplied |
| Terms URL | `<public terms URL>` | Terms and legal approval not supplied |
| Security URL | `<public security URL>` | Public URL not supplied |

## Short description — 119 of 140 characters

```text
Recreate deleted Clockify time entries as new entries with permission checks, clear warnings, and duplicate protection.
```

## Long description — 1,482 of 1,500 characters

```text
RestoreTime helps Clockify users recreate deleted time entries as new entries.

When Clockify sends a deletion event, RestoreTime keeps a normalized copy of the deleted entry. This copy can include its description, time, owner, project, task, tags, billable value, time zone, and custom-field values. The new entry has a new ID and current Clockify rates. It is not part of an approval request or linked to an invoice.

Before recreation, RestoreTime checks the current workspace. It verifies the owner, project, task, tags, custom fields, required values, billable permissions, and time-entry locks. If a source value is no longer valid, RestoreTime blocks the action, shows a warning, or asks the user to choose. It never changes a source value without a clear warning or choice.

Regular users can see and recreate only their own deleted entries. Workspace owners and admins can work with deleted entries across the workspace. The server enforces all permissions from verified Clockify claims.

An atomic database claim stops concurrent attempts. RestoreTime does not automatically retry an unclear write. It reports an unknown result. A new attempt needs repeated checks with no match and explicit user confirmation.

RestoreTime keeps normalized deleted-entry data after recreation or dismissal. When Clockify delivers the uninstall lifecycle call, RestoreTime hard-deletes the workspace data it holds. See the Privacy notice for the delivery-dependent uninstall qualification.
```

## Feature list — 5 items

1. Recreate a deleted time entry as a separate new Clockify entry.
2. Check the owner, project, task, tags, custom fields, permissions, and locks before recreation.
3. Show warnings and required choices before confirmation. Never change a source value silently.
4. Limit regular users to their own deleted entries. Give workspace owners and admins workspace-wide access.
5. Stop concurrent duplicate recreation and require explicit recovery after an unknown result.

## Screenshot caption candidates — 4 items

No Marketplace screenshots exist yet. Use these captions only after a matching screenshot is
captured from the release candidate.

| View | Caption | Count |
|---|---|---:|
| Deleted entries | Find deleted entries that you can recreate. | 43 characters |
| Preflight | Review the new entry, warnings, and required choices. | 53 characters |
| Confirmation | Confirm the exact recreation plan before RestoreTime writes to Clockify. | 72 characters |
| Result | See the new entry ID, fidelity, differences, or an unknown-result warning. | 74 characters |

## Support summary — 147 characters

```text
Get help with installation, deleted-entry visibility, recreation warnings, and unknown results. Do not send tokens or sensitive time-entry content.
```

For an unknown result, the support instructions must tell the user not to repeat the write. The user
must check Clockify first. A support request can include the approximate time, the visible status,
and nonsecret IDs. It must not include tokens, raw headers, or deleted-entry content.
