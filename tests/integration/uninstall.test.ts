// IT-11 (docs/13). Real SQLite temp file: the DELETED lifecycle purges the installation row and
// every workspace row across all three domain tables, in one transaction (docs/08, AGENTS.md
// rule 14).
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
import { createServer } from "../../src/server.js";
import { openDatabase } from "../../src/store/db.js";
import { ingestDeletedEntry } from "../../src/store/entries.js";
import { uninstallWorkspace } from "../../src/store/cascade.js";
import type { AppConfig } from "../../src/config.js";

const ADDON_KEY = "restoretime-test";
const WORKSPACE_ID = "ws-1";
const OTHER_WORKSPACE_ID = "ws-2";
const ADDON_ID = "addon-install-1";

let dir: string;
let keys: ClockifyTestKeys;

function testConfig(): AppConfig {
  return {
    port: 0,
    publicBaseUrl: "https://addon.example.invalid",
    clockifyParentOrigin: "https://app.clockify.me",
    databasePath: join(dir, "restoretime.sqlite"),
    addonKey: ADDON_KEY,
    tokenEncryptionKeyHex: "00".repeat(32),
    logLevel: "error",
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "restoretime-uninstall-it-"));
  keys = await generateTestKeys();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("IT-11 uninstall purges all workspace rows", () => {
  it("removes the installation and every recoverable_entries/plans/attempts row for the workspace, leaving other workspaces untouched", async () => {
    const server = await createServer(testConfig(), { publicKey: keys.publicKey });

    const installToken = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
    });
    await server.addon.handle(
      createTestLifecycleRequest(
        installToken,
        buildInstalledPayload({ workspaceId: WORKSPACE_ID, addonId: ADDON_ID }),
        { path: "/lifecycle/installed" },
      ),
    );

    // Seed one recoverable entry, one plan, one attempt for the target workspace, plus a row for
    // a different workspace that must survive.
    server.db
      .prepare(
        `INSERT INTO recoverable_entries
           (id, workspace_id, source_entry_id, owner_id, detected_at, source_json, lifecycle_state)
         VALUES ('re-1', ?, 'entry-1', 'user-1', '2026-08-08T00:00:00.000Z', '{}', 'IDLE')`,
      )
      .run(WORKSPACE_ID);
    server.db
      .prepare(
        `INSERT INTO recreation_plans
           (id, recoverable_entry_id, created_by, created_at, source_hash, choices_json, resolution_json,
            planned_request_json, warnings_json, blockers_json, action_required_json, fidelity, status)
         VALUES ('plan-1', 're-1', 'user-1', '2026-08-08T00:00:01.000Z', 'hash', '{}', '[]', '{}', '[]', '[]', '[]', 'FULL', 'ACTIVE')`,
      )
      .run();
    server.db
      .prepare(
        `INSERT INTO recreation_attempts (id, plan_id, recoverable_entry_id, started_at, baseline_json)
         VALUES ('att-1', 'plan-1', 're-1', '2026-08-08T00:00:02.000Z', '[]')`,
      )
      .run();
    server.db
      .prepare(
        `INSERT INTO recoverable_entries
           (id, workspace_id, source_entry_id, owner_id, detected_at, source_json, lifecycle_state)
         VALUES ('re-other', ?, 'entry-other', 'user-2', '2026-08-08T00:00:00.000Z', '{}', 'IDLE')`,
      )
      .run(OTHER_WORKSPACE_ID);

    const deleteToken = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
    });
    const response = await server.addon.handle(
      createTestLifecycleRequest(
        deleteToken,
        { workspaceId: WORKSPACE_ID, addonId: ADDON_ID, asUser: "user-1" },
        { path: "/lifecycle/deleted" },
      ),
    );
    expect(response.status).toBe(204);

    expect(await server.installations.load(WORKSPACE_ID, ADDON_ID)).toBeNull();
    expect(
      (server.db.prepare("SELECT COUNT(*) AS n FROM recoverable_entries WHERE workspace_id = ?").get(WORKSPACE_ID) as { n: number }).n,
    ).toBe(0);
    expect(
      (server.db.prepare("SELECT COUNT(*) AS n FROM recreation_plans").get() as { n: number }).n,
    ).toBe(0);
    expect(
      (server.db.prepare("SELECT COUNT(*) AS n FROM recreation_attempts").get() as { n: number }).n,
    ).toBe(0);

    // Untouched: the other workspace's row.
    expect(
      (server.db.prepare("SELECT COUNT(*) AS n FROM recoverable_entries WHERE workspace_id = ?").get(OTHER_WORKSPACE_ID) as { n: number }).n,
    ).toBe(1);
  });
});

// The point of the single transaction is that a partial purge is impossible. Asserting only the
// end state would pass just as well for two sequential deletes, so force the second statement to
// fail and assert that the first one rolled back with it.
describe("IT-11 the purge is one transaction, not two sequential deletes", () => {
  it("rolls the entry delete back when the installation delete fails", () => {
    const db = openDatabase(join(dir, "atomicity.sqlite"));
    db.prepare(
      `INSERT INTO installations (workspace_id, addon_id, addon_user_id, as_user, api_url, auth_token, installed_at)
       VALUES (?, ?, 'addon-user-1', 'user-1', 'https://developer.clockify.me/api', 'tok', 1000)`,
    ).run(WORKSPACE_ID, ADDON_ID);
    ingestDeletedEntry(db, {
      id: "re-1",
      workspaceId: WORKSPACE_ID,
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: {
        workspaceId: WORKSPACE_ID,
        entryId: "entry-a",
        ownerId: "user-1",
        ownerName: "User One",
        description: "d",
        billable: true,
        start: "2026-08-08T10:00:00Z",
        end: "2026-08-08T11:00:00Z",
        wasRunning: false,
        type: "REGULAR",
        timeZone: "UTC",
        projectId: null,
        projectName: null,
        clientName: null,
        taskId: null,
        taskName: null,
        tags: [],
        customFieldValues: [],
      },
    });

    // A trigger that rejects the installations DELETE stands in for any mid-transaction failure.
    db.exec(
      `CREATE TRIGGER block_installation_delete BEFORE DELETE ON installations
       BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`,
    );

    expect(() => uninstallWorkspace(db, WORKSPACE_ID, ADDON_ID)).toThrow();

    const entryCount = db
      .prepare("SELECT COUNT(*) AS n FROM recoverable_entries WHERE workspace_id = ?")
      .get(WORKSPACE_ID) as { n: number };
    expect(entryCount.n).toBe(1);
    db.close();
  });
});
