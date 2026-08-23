import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/store/db.js";

describe("openDatabase migrations", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("a fresh in-memory database reaches user_version=5", () => {
    const db = openDatabase(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(5);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('installations', 'retired_installations', 'recoverable_entries', 'recreation_plans', 'recreation_attempts')",
      )
      .all();
    expect(tables).toHaveLength(5);
    const presentation = db.prepare("PRAGMA table_info(recreation_plans)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(presentation).toContainEqual(expect.objectContaining({ name: "presentation_json", notnull: 0 }));
    db.close();
  });

  it("a second boot on the same database file is a no-op and keeps existing rows", () => {
    dir = mkdtempSync(join(tmpdir(), "restoretime-migrate-"));
    const dbPath = join(dir, "restoretime.sqlite");

    const first = openDatabase(dbPath);
    expect(first.pragma("user_version", { simple: true })).toBe(5);
    first
      .prepare(
        `INSERT INTO installations
           (workspace_id, addon_id, addon_user_id, as_user, api_url, auth_token, installed_at)
         VALUES ('ws-1', 'addon-1', 'addon-user-1', 'user-1', 'https://developer.clockify.me/api', 'tok', 1000)`,
      )
      .run();
    first.close();

    const second = openDatabase(dbPath);
    expect(second.pragma("user_version", { simple: true })).toBe(5);
    const row = second
      .prepare("SELECT * FROM installations WHERE workspace_id = ? AND addon_id = ?")
      .get("ws-1", "addon-1");
    expect(row).toBeDefined();
    second.close();
  });

  it("attributes migrated rows to the workspace's newest installation and drops orphans", () => {
    dir = mkdtempSync(join(tmpdir(), "restoretime-migrate-v4-"));
    const dbPath = join(dir, "restoretime.sqlite");
    const legacy = new Database(dbPath);
    for (const version of ["0001_init.sql", "0002_recovery.sql", "0003_plan_presentation.sql"]) {
      legacy.exec(readFileSync(join(process.cwd(), "src/store/migrations", version), "utf8"));
    }
    legacy.pragma("user_version = 3");
    // Two generations for one workspace, which is what a reinstall whose DELETED never arrived
    // leaves behind, plus a workspace whose installation is gone entirely.
    legacy.prepare(
      `INSERT INTO installations
         (workspace_id, addon_id, addon_user_id, as_user, api_url, auth_token, installed_at)
       VALUES
         ('ws-1', 'addon-old', 'addon-user-1', 'user-1', 'https://developer.clockify.me/api', 'tok', 1000),
         ('ws-1', 'addon-new', 'addon-user-1', 'user-1', 'https://developer.clockify.me/api', 'tok', 2000)`,
    ).run();
    legacy.prepare(
      `INSERT INTO recoverable_entries
         (id, workspace_id, source_entry_id, owner_id, detected_at, source_json, lifecycle_state)
       VALUES
         ('entry-kept', 'ws-1', 'source-kept', 'user-1', '2026-08-08T09:00:00Z', '{}', 'IDLE'),
         ('entry-orphan', 'ws-gone', 'source-orphan', 'user-1', '2026-08-08T09:00:00Z', '{}', 'IDLE')`,
    ).run();
    legacy.close();

    const migrated = openDatabase(dbPath);
    expect(migrated.pragma("user_version", { simple: true })).toBe(5);
    // The surviving row belongs to the newest generation; the superseded installation is gone.
    expect(migrated.prepare("SELECT id, addon_id FROM recoverable_entries ORDER BY id").all()).toEqual([
      { id: "entry-kept", addon_id: "addon-new" },
    ]);
    expect(migrated.prepare("SELECT addon_id FROM installations ORDER BY addon_id").all()).toEqual([
      { addon_id: "addon-new" },
    ]);
    // The superseded generation is recorded, so a replayed INSTALLED for it can never be read as
    // proof that the survivor is obsolete.
    expect(migrated.prepare("SELECT addon_id FROM retired_installations").all()).toEqual([
      { addon_id: "addon-old" },
    ]);
    expect(migrated.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("migrates a populated version 2 database without inventing presentation data", () => {
    dir = mkdtempSync(join(tmpdir(), "restoretime-migrate-v2-"));
    const dbPath = join(dir, "restoretime.sqlite");
    const legacy = new Database(dbPath);
    for (const version of ["0001_init.sql", "0002_recovery.sql"]) {
      legacy.exec(readFileSync(join(process.cwd(), "src/store/migrations", version), "utf8"));
    }
    legacy.pragma("user_version = 2");
    // A version-2 database always holds the installation that captured its rows — an entry cannot
    // be ingested without one. Migration 0004 attributes rows to it.
    legacy.prepare(
      `INSERT INTO installations
         (workspace_id, addon_id, addon_user_id, as_user, api_url, auth_token, installed_at)
       VALUES ('ws-1', 'addon-1', 'addon-user-1', 'user-1', 'https://developer.clockify.me/api', 'tok', 1000)`,
    ).run();
    legacy.prepare(
      `INSERT INTO recoverable_entries
         (id, workspace_id, source_entry_id, owner_id, detected_at, source_json, lifecycle_state)
       VALUES
         ('entry-1', 'ws-1', 'source-1', 'user-1', '2026-08-08T09:00:00Z', '{}', 'RECREATED'),
         ('entry-ambiguous', 'ws-1', 'source-ambiguous', 'user-1', '2026-08-08T09:01:00Z', '{}', 'AMBIGUOUS'),
         ('entry-recreating', 'ws-1', 'source-recreating', 'user-1', '2026-08-08T09:02:00Z', '{}', 'RECREATING'),
         ('entry-recreating-success', 'ws-1', 'source-recreating-success', 'user-1', '2026-08-08T09:03:00Z', '{}', 'RECREATING'),
         ('entry-recreating-failed', 'ws-1', 'source-recreating-failed', 'user-1', '2026-08-08T09:04:00Z', '{}', 'RECREATING')`,
    ).run();
    legacy.prepare(
      `INSERT INTO recreation_plans
         (id, recoverable_entry_id, created_by, created_at, source_hash, choices_json,
          resolution_json, planned_request_json, warnings_json, blockers_json,
          action_required_json, fidelity, status)
       VALUES
         ('plan-1', 'entry-1', 'user-1', '2026-08-08T09:00:01Z', 'hash', '{}', '[]', '{}', '[]', '[]', '[]', 'FULL', 'CONSUMED'),
         ('plan-ambiguous', 'entry-ambiguous', 'user-1', '2026-08-08T09:01:01Z', 'hash', '{}', '[]', '{}', '[]', '[]', '[]', 'FULL', 'CONSUMED'),
         ('plan-recreating', 'entry-recreating', 'user-1', '2026-08-08T09:02:01Z', 'hash', '{}', '[]', '{}', '[]', '[]', '[]', 'FULL', 'CONSUMED'),
         ('plan-recreating-success', 'entry-recreating-success', 'user-1', '2026-08-08T09:03:01Z', 'hash', '{}', '[]', '{}', '[]', '[]', '[]', 'FULL', 'CONSUMED'),
         ('plan-recreating-failed', 'entry-recreating-failed', 'user-1', '2026-08-08T09:04:01Z', 'hash', '{}', '[]', '{}', '[]', '[]', '[]', 'FULL', 'CONSUMED')`,
    ).run();
    legacy.prepare(
      `INSERT INTO recreation_attempts
         (id, plan_id, recoverable_entry_id, started_at, outcome, baseline_json, reconcile_json)
       VALUES
         ('attempt-resolved', 'plan-1', 'entry-1', '2026-08-08T09:00:02Z', 'SUCCESS', '["old-resolved"]', '{"checks":3}'),
         ('attempt-ambiguous', 'plan-ambiguous', 'entry-ambiguous', '2026-08-08T09:01:02Z', 'AMBIGUOUS', '["keep-ambiguous"]', '{"checks":1}'),
         ('attempt-recreating', 'plan-recreating', 'entry-recreating', '2026-08-08T09:02:02Z', NULL, '["keep-recreating"]', '{"checks":0}'),
         ('attempt-recreating-success', 'plan-recreating-success', 'entry-recreating-success', '2026-08-08T09:03:02Z', 'SUCCESS', '["clear-success"]', '{"checks":2}'),
         ('attempt-recreating-failed', 'plan-recreating-failed', 'entry-recreating-failed', '2026-08-08T09:04:02Z', 'FAILED', '["clear-failed"]', '{"checks":2}')`,
    ).run();
    legacy.close();

    const migrated = openDatabase(dbPath);
    expect(migrated.pragma("user_version", { simple: true })).toBe(5);
    expect(migrated.prepare(
      "SELECT id, presentation_json FROM recreation_plans ORDER BY id",
    ).all()).toEqual([
      { id: "plan-1", presentation_json: null },
      { id: "plan-ambiguous", presentation_json: null },
      { id: "plan-recreating", presentation_json: null },
      { id: "plan-recreating-failed", presentation_json: null },
      { id: "plan-recreating-success", presentation_json: null },
    ]);
    expect(migrated.prepare(
      "SELECT id FROM recoverable_entries WHERE id='entry-1'",
    ).get()).toEqual({ id: "entry-1" });
    expect(migrated.prepare(
      "SELECT id, baseline_json, reconcile_json FROM recreation_attempts ORDER BY id",
    ).all()).toEqual([
      { id: "attempt-ambiguous", baseline_json: '["keep-ambiguous"]', reconcile_json: '{"checks":1}' },
      { id: "attempt-recreating", baseline_json: '["keep-recreating"]', reconcile_json: '{"checks":0}' },
      { id: "attempt-recreating-failed", baseline_json: null, reconcile_json: null },
      { id: "attempt-recreating-success", baseline_json: null, reconcile_json: null },
      { id: "attempt-resolved", baseline_json: null, reconcile_json: null },
    ]);
    migrated.close();
  });
});
