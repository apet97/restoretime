// Starts one command with one exact installation in its child environment. The caller must name
// both keys. Selecting the newest row is unsafe when a database contains more than one
// installation.
//
// The token is the reason this exists: it cannot be obtained from Clockify's UI. It arrives in the
// INSTALLED lifecycle payload and this app stores it encrypted (docs/12). This process decrypts the
// token with the SDK codec and passes it directly to the child. It does not print or write the
// plaintext token.
//
// Requires `TOKEN_ENCRYPTION_KEY` and a command after the script name.
import Database from "better-sqlite3";
import { createClockifyAesGcmTokenCodec } from "@apet97/clockify-addon-sdk/clockify";
import { spawn } from "node:child_process";
import { webcrypto } from "node:crypto";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const databasePath = process.env.DATABASE_PATH ?? "var/live.sqlite";
const keyHex = process.env.TOKEN_ENCRYPTION_KEY;
const workspaceId = process.env.CK_LIVE_WS;
const addonId = process.env.CK_LIVE_ADDON_ID;
const expectedApiUrl = process.env.CK_LIVE_API_BASE?.replace(/\/+$/, "");
const [command, ...args] = process.argv.slice(2);
if (!keyHex) fail("TOKEN_ENCRYPTION_KEY is required (the codec key, normally `cat var/key.hex`)");
if (!workspaceId) fail("CK_LIVE_WS is required to select one installation");
if (!addonId) fail("CK_LIVE_ADDON_ID is required to select one installation");
if (!expectedApiUrl) fail("CK_LIVE_API_BASE is required to verify the selected installation");
if (!command) fail("usage: node scripts/read-installation.mjs <command> [args...]");
if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
  fail("TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
}

const db = new Database(databasePath, { readonly: true });
const rows = db
  .prepare(
    "SELECT workspace_id, addon_id, api_url, auth_token, status FROM installations WHERE workspace_id = ? AND addon_id = ?",
  )
  .all(workspaceId, addonId);
if (rows.length === 0) fail(`no installation ${workspaceId}/${addonId} in ${databasePath}`);
if (rows.length !== 1) fail(`installation selector ${workspaceId}/${addonId} matched ${rows.length} rows; expected exactly one`);
const row = rows[0];
if (String(row.api_url).replace(/\/+$/, "") !== expectedApiUrl) {
  fail(`installation ${workspaceId}/${addonId} belongs to API URL ${row.api_url}, expected ${expectedApiUrl}`);
}
if (row.status !== "ACTIVE") fail(`installation ${workspaceId}/${addonId} is not active`);
db.close();

const key = await webcrypto.subtle.importKey(
  "raw",
  Buffer.from(keyHex, "hex"),
  "AES-GCM",
  false,
  ["encrypt", "decrypt"],
);
let addonToken;
try {
  addonToken = await createClockifyAesGcmTokenCodec(key).decode(row.auth_token);
} catch {
  fail(`installation ${row.workspace_id}/${row.addon_id} has no readable token`);
}
if (!addonToken) fail(`installation ${row.workspace_id}/${row.addon_id} has no readable token`);

const childEnvironment = {
  ...process.env,
  CK_LIVE_ADDON_TOKEN: addonToken,
  CK_DEV_WORKSPACE_ID: row.workspace_id,
  CK_DEV_ADDON_ID: row.addon_id,
  CK_DEV_ADDON_TOKEN: addonToken,
  CK_LIVE_INSTALLATION_SOURCE: "local-database",
};
// The child needs the decrypted installation token, not the key that protects the database copy.
delete childEnvironment.TOKEN_ENCRYPTION_KEY;

const child = spawn(command, args, { env: childEnvironment, stdio: "inherit" });
child.once("error", (error) => fail(`could not start command: ${error.message}`));
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
