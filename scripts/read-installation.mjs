// Prints the current installation as three lines — workspaceId, addonId, addon token — so a shell
// can read them into environment variables without any of it touching disk.
//
// The token is the reason this exists: it cannot be obtained from Clockify's UI. It arrives in the
// INSTALLED lifecycle payload and this app stores it encrypted (docs/12). Decrypting it here uses
// the same codec `createServer` writes with, so a token this cannot read is a token the server
// could not have used either.
//
// Requires `npm run build` (it imports the compiled store) and `TOKEN_ENCRYPTION_KEY`.
import Database from "better-sqlite3";
import { createClockifyAesGcmTokenCodec, wrapClockifyInstallationStoreWithEncryption } from "@apet97/clockify-addon-sdk/clockify";
import { createSqliteInstallationStore, importTokenEncryptionKey } from "../dist/platform/installations.js";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const databasePath = process.env.DATABASE_PATH ?? "var/live.sqlite";
const keyHex = process.env.TOKEN_ENCRYPTION_KEY;
if (!keyHex) fail("TOKEN_ENCRYPTION_KEY is required (the codec key, normally `cat var/key.hex`)");

const db = new Database(databasePath, { readonly: true });
// Newest installation wins: a tunnel cycle leaves older rows behind whose tokens are dead.
const row = db.prepare("SELECT workspace_id, addon_id FROM installations ORDER BY rowid DESC LIMIT 1").get();
if (!row) fail(`no installation in ${databasePath} — install the addon on the workspace first`);

const store = wrapClockifyInstallationStoreWithEncryption(
  createSqliteInstallationStore(db),
  createClockifyAesGcmTokenCodec(await importTokenEncryptionKey(keyHex)),
);
const record = await store.load(row.workspace_id, row.addon_id);
if (!record?.authToken) fail(`installation ${row.workspace_id}/${row.addon_id} has no readable token`);

process.stdout.write(`${row.workspace_id}\n${row.addon_id}\n${record.authToken}\n`);
