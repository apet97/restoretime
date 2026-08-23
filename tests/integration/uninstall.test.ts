// IT-11 (docs/13). Real SQLite temp file: the DELETED lifecycle purges the addressed installation
// generation and everything it owns — and nothing else. Scoped by `(workspace_id, addon_id)`, never
// by workspace alone (docs/08, AGENTS.md rule 14, src/store/cascade.ts).
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
import { uninstallInstallation } from "../../src/store/cascade.js";
import { ingestEntry, seedInstallation } from "../support/installation-fixture.js";
import type { AppConfig } from "../../src/config.js";

const ADDON_KEY = "restoretime-test";
const WORKSPACE_ID = "ws-1";
const OTHER_WORKSPACE_ID = "ws-2";
const ADDON_ID = "addon-install-1";
const SCOPE = { workspaceId: WORKSPACE_ID, addonId: ADDON_ID };

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

function countEntries(db: ReturnType<typeof openDatabase>, workspaceId: string, addonId?: string): number {
  const sql = addonId === undefined
    ? "SELECT COUNT(*) AS n FROM recoverable_entries WHERE workspace_id = ?"
    : "SELECT COUNT(*) AS n FROM recoverable_entries WHERE workspace_id = ? AND addon_id = ?";
  const args = addonId === undefined ? [workspaceId] : [workspaceId, addonId];
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "restoretime-uninstall-it-"));
  keys = await generateTestKeys();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("IT-11 uninstall purges the installation's own rows", () => {
  it("removes the installation and its recoverable_entries/plans/attempts, leaving other workspaces untouched", async () => {
    const server = await createServer(testConfig(), { publicKey: keys.publicKey });
    seedInstallation(server.db, SCOPE);

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

    // One recoverable entry, one plan, one attempt for the target installation, plus a row for a
    // different workspace that must survive.
    server.db
      .prepare(
        `INSERT INTO recoverable_entries
           (id, workspace_id, addon_id, source_entry_id, owner_id, detected_at, source_json, lifecycle_state)
         VALUES ('re-1', ?, ?, 'entry-1', 'user-1', '2026-08-08T00:00:00.000Z', '{}', 'IDLE')`,
      )
      .run(WORKSPACE_ID, ADDON_ID);
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
    seedInstallation(server.db, { workspaceId: OTHER_WORKSPACE_ID, addonId: "addon-other" });
    server.db
      .prepare(
        `INSERT INTO recoverable_entries
           (id, workspace_id, addon_id, source_entry_id, owner_id, detected_at, source_json, lifecycle_state)
         VALUES ('re-other', ?, 'addon-other', 'entry-other', 'user-2', '2026-08-08T00:00:00.000Z', '{}', 'IDLE')`,
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
    expect(countEntries(server.db, WORKSPACE_ID)).toBe(0);
    expect((server.db.prepare("SELECT COUNT(*) AS n FROM recreation_plans").get() as { n: number }).n).toBe(0);
    expect((server.db.prepare("SELECT COUNT(*) AS n FROM recreation_attempts").get() as { n: number }).n).toBe(0);

    // Untouched: the other workspace's row.
    expect(countEntries(server.db, OTHER_WORKSPACE_ID)).toBe(1);
  });
});

describe("IT-11 a lifecycle event may only purge its own generation", () => {
  it("leaves a later installation and its data intact when a stale DELETED arrives for an earlier one", () => {
    const db = openDatabase(join(dir, "generation.sqlite"));
    seedInstallation(db, SCOPE);
    const oldScope = { workspaceId: WORKSPACE_ID, addonId: "addon-old" };
    const newScope = { workspaceId: WORKSPACE_ID, addonId: "addon-new" };
    seedInstallation(db, oldScope, 1_000);
    seedInstallation(db, newScope, 2_000);
    ingestEntry(db, {
      id: "re-old",
      scope: oldScope,
      sourceEntryId: "entry-old",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: sourceFor(WORKSPACE_ID, "entry-old"),
    });
    ingestEntry(db, {
      id: "re-new",
      scope: newScope,
      sourceEntryId: "entry-new",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:10:00Z",
      source: sourceFor(WORKSPACE_ID, "entry-new"),
    });

    // The delayed event for the superseded generation. Under the old workspace-wide cascade this
    // erased the current installation's recovery data while leaving the installation itself active.
    expect(uninstallInstallation(db, oldScope)).toBe("deleted");

    expect(countEntries(db, WORKSPACE_ID, "addon-old")).toBe(0);
    expect(countEntries(db, WORKSPACE_ID, "addon-new")).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM installations WHERE workspace_id = ? AND addon_id = ?")
        .get(WORKSPACE_ID, "addon-new") as { n: number },
    ).toEqual({ n: 1 });
    db.close();
  });

  it("reports a second DELETED for the same generation as stale and changes nothing", () => {
    const db = openDatabase(join(dir, "idempotent.sqlite"));
    seedInstallation(db, SCOPE);
    seedInstallation(db, SCOPE);
    ingestEntry(db, {
      id: "re-1",
      scope: SCOPE,
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: sourceFor(WORKSPACE_ID, "entry-a"),
    });

    expect(uninstallInstallation(db, SCOPE)).toBe("deleted");
    expect(uninstallInstallation(db, SCOPE)).toBe("stale");
    expect(countEntries(db, WORKSPACE_ID)).toBe(0);
    db.close();
  });
});

// The point of the single transaction is that a partial purge is impossible. Asserting only the
// end state would pass just as well for two sequential deletes, so force the second statement to
// fail and assert that the first one rolled back with it.
describe("IT-11 the purge is one transaction, not two sequential deletes", () => {
  it("rolls the entry delete back when the installation delete fails", () => {
    const db = openDatabase(join(dir, "atomicity.sqlite"));
    seedInstallation(db, SCOPE);
    seedInstallation(db, SCOPE);
    ingestEntry(db, {
      id: "re-1",
      scope: SCOPE,
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: sourceFor(WORKSPACE_ID, "entry-a"),
    });

    // A trigger that rejects the installations DELETE stands in for any mid-transaction failure.
    db.exec(
      `CREATE TRIGGER block_installation_delete BEFORE DELETE ON installations
       BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`,
    );

    expect(() => uninstallInstallation(db, SCOPE)).toThrow();
    expect(countEntries(db, WORKSPACE_ID)).toBe(1);
    db.close();
  });
});

function sourceFor(workspaceId: string, entryId: string) {
  return {
    workspaceId,
    entryId,
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
  };
}
