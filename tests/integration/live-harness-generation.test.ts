// The `tests/live/` in-process harness (LV-03…LV-10) installs the add-on under its own synthetic
// identity — a test-signed platform key can only claim a synthetic add-on key and id — and then
// seeds `recoverable_entries` rows through `seedRecoverableEntry`. Those two must name the same
// installation generation, or the generation fence in `ingestDeletedEntry` rejects every seed and
// the whole live suite fails before it reaches Clockify.
//
// Nothing offline exercised that pairing, so when `(workspace_id, addon_id)` became the ownership
// key (migration 0004) `liveScope` was pointed at `CK_LIVE_ADDON_ID` — the *Clockify-side*
// installation id, which the receipts and the token handoff need and the local harness never
// installs. This test is that missing offline coverage: it repeats the harness's install and its
// seed scope with no network and no live credentials.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInstalledPayload,
  createTestLifecycleRequest,
  generateTestKeys,
  signTestToken,
  type ClockifyTestKeys,
} from "@apet97/clockify-addon-sdk/testing";
import { createServer, type AppServer } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";
import type { DeletedTimeEntry } from "../../src/domain/entry.js";
import { ingestDeletedEntry } from "../../src/store/entries.js";
import { LIVE_ADDON_ID, LIVE_ADDON_KEY, liveScope, type LiveEnv } from "../live/support.js";

const WORKSPACE_ID = "ws-live-harness";
const OWNER_ID = "user-1";

/** The env the live suite builds from `.env.live`. Only the two fields `liveScope` can read are
 * meaningful here; `addonId` deliberately holds a *different* value from `LIVE_ADDON_ID`, because
 * that is exactly what a real `.env.live` holds — the Clockify-issued installation id. */
const env = {
  workspaceId: WORKSPACE_ID,
  addonId: "6a8a55823e328737e6b9556c",
} as LiveEnv;

let dir: string;
let keys: ClockifyTestKeys;
let server: AppServer;

function testConfig(): AppConfig {
  return {
    port: 0,
    publicBaseUrl: "https://addon.example.invalid",
    clockifyParentOrigin: "https://developer.clockify.me",
    databasePath: join(dir, "restoretime.sqlite"),
    addonKey: LIVE_ADDON_KEY,
    tokenEncryptionKeyHex: "00".repeat(32),
    logLevel: "error",
  };
}

function deletedEntry(entryId: string): DeletedTimeEntry {
  return {
    workspaceId: WORKSPACE_ID,
    entryId,
    ownerId: OWNER_ID,
    ownerName: "Owner",
    description: "RT-PROBE-harness",
    billable: false,
    start: "2026-08-23T07:00:00Z",
    end: "2026-08-23T08:00:00Z",
    wasRunning: false,
    type: "REGULAR",
    timeZone: null,
    projectId: null,
    projectName: null,
    clientName: null,
    taskId: null,
    taskName: null,
    tags: [],
    customFieldValues: [],
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rt-live-harness-"));
  keys = await generateTestKeys();
  server = await createServer(testConfig(), { publicKey: keys.publicKey });

  // Byte-for-byte the install `startLiveHarness` performs, minus the real installation token.
  const installToken = await signTestToken(keys.privateKey, LIVE_ADDON_KEY, {
    workspaceId: WORKSPACE_ID,
    addonId: LIVE_ADDON_ID,
  });
  await server.addon.handle(
    createTestLifecycleRequest(
      installToken,
      buildInstalledPayload({
        workspaceId: WORKSPACE_ID,
        addonId: LIVE_ADDON_ID,
        apiUrl: "https://developer.clockify.me/api",
        authToken: "live-harness-token",
      }),
      { path: "/lifecycle/installed" },
    ),
  );
});

afterEach(() => {
  server.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("live harness installation generation (docs/13 'Live suite')", () => {
  it("seeds into the generation the harness installed, not the Clockify-side installation id", () => {
    const scope = liveScope(env);
    const result = ingestDeletedEntry(server.db, {
      id: "re-1",
      scope,
      sourceEntryId: "source-1",
      ownerId: OWNER_ID,
      detectedAt: "2026-08-23T07:35:53.353Z",
      source: deletedEntry("source-1"),
    });

    // `installation-gone` is the fence rejecting a row that belongs to no installation. Every
    // LV-03…LV-10 seed goes through this call, so this outcome fails the whole live suite. It is
    // asserted before the identity checks so a regression reports the symptom, not the cause.
    expect(result.kind).toBe("inserted");
    expect(scope.workspaceId).toBe(WORKSPACE_ID);
    expect(scope.addonId).toBe(LIVE_ADDON_ID);
  });

  it("keeps the Clockify-side installation id available for receipts and the token handoff", () => {
    // `liveScope` must not be "fixed" by overwriting `env.addonId`: the receipts, the strict
    // runner's JWT claim check, and the Railway handoff all compare against that exact value.
    expect(env.addonId).not.toBe(LIVE_ADDON_ID);
  });
});
