// ClockifyManifest builder: scalar fields + scopes, plus the webhook/component/lifecycle
// descriptor builders (docs/04, docs/05). Built without entities first; server.ts registers each
// entity with its verified wrapper — registration is what adds it to the served manifest
// (Addon.registerWebhook/registerComponent/registerLifecycleEvent, fact 2).

import {
  ClockifyComponent,
  ClockifyLifecycleEvent,
  ClockifyManifest,
  ClockifyScope,
  ClockifyWebhook,
} from "@apet97/clockify-addon-sdk/clockify";

export const WEBHOOK_PATH = "/webhooks/time-entry-deleted";
export const COMPONENT_PATH = "/component";
export const ICON_PATH = "/icon.svg";
export const STATIC_APP_JS_PATH = "/static/app.js";
export const LIFECYCLE_PATHS = {
  installed: "/lifecycle/installed",
  statusChanged: "/lifecycle/status-changed",
  deleted: "/lifecycle/deleted",
} as const;

export interface ManifestConfig {
  readonly addonKey: string;
  readonly publicBaseUrl: string;
}

/** Scalar manifest fields + scopes only — no entities (docs/04 "Manifest construction pattern"). */
export function buildManifest(config: ManifestConfig) {
  return ClockifyManifest.v1_5Builder()
    .key(config.addonKey)
    .name("RestoreTime — Time Entry Recovery")
    .baseUrl(config.publicBaseUrl)
    .requireFreePlan()
    .description(
      "Recovers deleted time entries. Keeps a copy when you delete a time entry and recreates it as a new entry on your confirmation.",
    )
    .iconPath(ICON_PATH)
    .scopes([
      ClockifyScope.TIME_ENTRY_READ,
      ClockifyScope.TIME_ENTRY_WRITE,
      ClockifyScope.PROJECT_READ,
      ClockifyScope.TASK_READ,
      ClockifyScope.TAG_READ,
      ClockifyScope.USER_READ,
      ClockifyScope.CUSTOM_FIELDS_READ,
      ClockifyScope.WORKSPACE_READ,
    ])
    .build();
}

export function webhookDescriptor() {
  return ClockifyWebhook.v1_5Builder().onTimeEntryDeleted().path(WEBHOOK_PATH).build();
}

export function componentDescriptor() {
  return ClockifyComponent.v1_5Builder()
    .sidebar()
    .allowEveryone()
    .path(COMPONENT_PATH)
    .label("Time Entry Recovery")
    .iconPath(ICON_PATH)
    .build();
}

export function lifecycleDescriptors() {
  return {
    installed: ClockifyLifecycleEvent.v1_5Builder()
      .path(LIFECYCLE_PATHS.installed)
      .onInstalled()
      .build(),
    statusChanged: ClockifyLifecycleEvent.v1_5Builder()
      .path(LIFECYCLE_PATHS.statusChanged)
      .onStatusChanged()
      .build(),
    deleted: ClockifyLifecycleEvent.v1_5Builder()
      .path(LIFECYCLE_PATHS.deleted)
      .onDeleted()
      .build(),
  };
}
