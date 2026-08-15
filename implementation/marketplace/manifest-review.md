# Manifest review (docs/15 "Marketplace manifest review package")

`GET /manifest` serves this at runtime (the addon SDK's built-in manifest route,
`Addon.PATH_MANIFEST`, no auth) — validated at boot by `createValidatedClockifyAddon`
(`src/server.ts`), so the process refuses to start on an invalid manifest. Every field below is
read from `buildManifest()` (`src/manifest.ts`); `<future production>` marks the one value that a
later production deployment must supply. The developer-environment URL is not a Marketplace URL.

| Field | Value | Source |
|---|---|---|
| `key` | `ADDON_KEY` env var (operator-chosen, stable identifier) | `config.addonKey` |
| `name` | "RestoreTime — Time Entry Recovery" | `src/manifest.ts` |
| `baseUrl` | `<future production PUBLIC_BASE_URL>` | `config.publicBaseUrl` |
| `minimalSubscriptionPlan` | FREE (`.requireFreePlan()`) | `src/manifest.ts` — no evidence in this pass demands a paid tier |
| `description` | "Keeps the details of deleted time entries. After you confirm, RestoreTime recreates each deleted entry as a new entry." | `src/manifest.ts` |
| `iconPath` | `/icon.svg` | `src/manifest.ts`, served by `src/server.ts` |
| `scopes` | `TIME_ENTRY_READ`, `TIME_ENTRY_WRITE`, `PROJECT_READ`, `TASK_READ`, `TAG_READ`, `USER_READ`, `CUSTOM_FIELDS_READ`, `WORKSPACE_READ` | `src/manifest.ts` — justified one-by-one in `scope-justification.md` |
| Webhook | `TIME_ENTRY_DELETED` → `/webhooks/time-entry-deleted` | `src/manifest.ts` `webhookDescriptor()` |
| Component | Sidebar, `allowEveryone()`, path `/component`, label "Time Entry Recovery", icon `/icon.svg` | `src/manifest.ts` `componentDescriptor()` |
| Lifecycle events | `INSTALLED` → `/lifecycle/installed`; `STATUS_CHANGED` → `/lifecycle/status-changed`; `DELETED` → `/lifecycle/deleted` | `src/manifest.ts` `lifecycleDescriptors()` |

## Boot-time validation contract

`createValidatedClockifyAddon` runs the SDK's manifest JSON-schema validation before the process
accepts any request. `tests/unit/server.test.ts` covers this path offline. A malformed manifest
(missing scope, bad URL shape, etc.) is a boot failure. Run the current-candidate local gates before
release; the existence of this review file is not test evidence.

## Terminology in manifest-visible strings

`name` and `description` were checked by the same terminology audit as every other user-facing
string (`terminology-check.md`): "keeps the details" and "recreates … as a new entry" — no
"restore", "undelete", or "original entry".
