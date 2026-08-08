import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/store/db.js";

describe("openDatabase migrations", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("a fresh in-memory database reaches user_version=1", () => {
    const db = openDatabase(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'installations'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it("a second boot on the same database file is a no-op and keeps existing rows", () => {
    dir = mkdtempSync(join(tmpdir(), "restoretime-migrate-"));
    const dbPath = join(dir, "restoretime.sqlite");

    const first = openDatabase(dbPath);
    expect(first.pragma("user_version", { simple: true })).toBe(1);
    first
      .prepare(
        `INSERT INTO installations
           (workspace_id, addon_id, addon_user_id, as_user, api_url, auth_token, installed_at)
         VALUES ('ws-1', 'addon-1', 'addon-user-1', 'user-1', 'https://developer.clockify.me/api', 'tok', 1000)`,
      )
      .run();
    first.close();

    const second = openDatabase(dbPath);
    expect(second.pragma("user_version", { simple: true })).toBe(1);
    const row = second
      .prepare("SELECT * FROM installations WHERE workspace_id = ? AND addon_id = ?")
      .get("ws-1", "addon-1");
    expect(row).toBeDefined();
    second.close();
  });
});
