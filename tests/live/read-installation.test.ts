import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClockifyAesGcmTokenCodec } from "@apet97/clockify-addon-sdk/clockify";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { importTokenEncryptionKey } from "../../src/platform/installations.js";
import { openDatabase } from "../../src/store/db.js";

const temporaryDirectories: string[] = [];
const readerPath = fileURLToPath(new URL("../../scripts/read-installation.mjs", import.meta.url));

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("live installation command wrapper", () => {
  it("gives the exact decrypted token to its child without writing the token to stdout", async () => {
    const directory = mkdtempSync(join(tmpdir(), "restoretime-live-installation-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "live.sqlite");
    const keyHex = "7a".repeat(32);
    const sentinelToken = "RT_SENTINEL_TOKEN_NEVER_PRINT_8f57be";
    const codec = createClockifyAesGcmTokenCodec(await importTokenEncryptionKey(keyHex));
    const encryptedToken = await codec.encode(sentinelToken);
    const decoyToken = "RT_DECOY_NEWEST_TOKEN_NEVER_SELECT";
    const encryptedDecoyToken = await codec.encode(decoyToken);

    const db = openDatabase(databasePath);
    db.prepare(`
      INSERT INTO installations
        (workspace_id, addon_id, addon_user_id, as_user, api_url, auth_token, status, installed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
    `).run("ws-exact", "addon-exact", "addon-user", "acting-user", "https://developer.clockify.me/api", encryptedToken, 1);
    db.prepare(`
      INSERT INTO installations
        (workspace_id, addon_id, addon_user_id, as_user, api_url, auth_token, status, installed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
    `).run("ws-decoy", "addon-decoy", "decoy-user", "acting-user", "https://developer.clockify.me/api", encryptedDecoyToken, 2);
    db.close();

    const expectedHash = createHash("sha256").update(sentinelToken).digest("hex");
    const childProgram = `
      const { createHash } = require("node:crypto");
      const token = process.env.CK_LIVE_ADDON_TOKEN || "";
      const hash = createHash("sha256").update(token).digest("hex");
      if (hash !== process.env.RT_EXPECTED_TOKEN_SHA256) process.exit(41);
      if (process.env.CK_DEV_ADDON_TOKEN !== token) process.exit(42);
      if (process.env.CK_DEV_WORKSPACE_ID !== "ws-exact") process.exit(43);
      if (process.env.CK_DEV_ADDON_ID !== "addon-exact") process.exit(44);
      if (process.env.TOKEN_ENCRYPTION_KEY !== undefined) process.exit(45);
      if (process.env.CK_LIVE_INSTALLATION_SOURCE !== "local-database") process.exit(46);
      process.stdout.write("child received exact installation\\n");
    `;
    const result = spawnSync(process.execPath, [readerPath, process.execPath, "-e", childProgram], {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_PATH: databasePath,
        TOKEN_ENCRYPTION_KEY: keyHex,
        CK_LIVE_WS: "ws-exact",
        CK_LIVE_ADDON_ID: "addon-exact",
        CK_LIVE_API_BASE: "https://developer.clockify.me/api/",
        RT_EXPECTED_TOKEN_SHA256: expectedHash,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("child received exact installation\n");
    expect(`${result.stdout}${result.stderr}`).not.toContain(sentinelToken);
    expect(`${result.stdout}${result.stderr}`).not.toContain(decoyToken);
  });

  it("fails closed when the exact selector matches zero or multiple rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "restoretime-live-selector-"));
    temporaryDirectories.push(directory);
    const keyHex = "6b".repeat(32);
    const emptyPath = join(directory, "empty.sqlite");
    openDatabase(emptyPath).close();
    const baseEnv = {
      ...process.env,
      TOKEN_ENCRYPTION_KEY: keyHex,
      CK_LIVE_WS: "ws-exact",
      CK_LIVE_ADDON_ID: "addon-exact",
      CK_LIVE_API_BASE: "https://developer.clockify.me/api",
    };
    const missing = spawnSync(process.execPath, [readerPath, process.execPath, "-e", "process.exit(0)"], {
      encoding: "utf8",
      env: { ...baseEnv, DATABASE_PATH: emptyPath },
    });
    if (missing.status === 0 || !missing.stderr.includes("no installation")) {
      throw new Error("the installation selector did not reject a zero-row result");
    }

    const duplicatePath = join(directory, "duplicates.sqlite");
    const duplicateDb = new Database(duplicatePath);
    duplicateDb.exec(`
      CREATE TABLE installations (
        workspace_id TEXT NOT NULL,
        addon_id TEXT NOT NULL,
        api_url TEXT NOT NULL,
        auth_token BLOB NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO installations VALUES
        ('ws-exact', 'addon-exact', 'https://developer.clockify.me/api', X'00', 'ACTIVE'),
        ('ws-exact', 'addon-exact', 'https://developer.clockify.me/api', X'01', 'ACTIVE');
    `);
    duplicateDb.close();
    const duplicate = spawnSync(process.execPath, [readerPath, process.execPath, "-e", "process.exit(0)"], {
      encoding: "utf8",
      env: { ...baseEnv, DATABASE_PATH: duplicatePath },
    });
    if (duplicate.status === 0 || !duplicate.stderr.includes("matched 2 rows")) {
      throw new Error("the installation selector did not reject a multiple-row result");
    }
  });
});
