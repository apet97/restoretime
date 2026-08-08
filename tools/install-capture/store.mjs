// Shared encrypted installation store for the install-capture tool (used by server.mjs and
// probe-addon-token.mjs). Contract: ClockifyInstallationStore (addon SDK), generation semantics
// included. Ciphertext lives at var/installations.json; the AES-GCM key at var/key.hex (0600).

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  wrapClockifyInstallationStoreWithEncryption,
  createClockifyAesGcmTokenCodec,
} from "@apet97/clockify-addon-sdk/clockify";

export const VAR_DIR = process.env.VAR_DIR ?? new URL("./var", import.meta.url).pathname;
mkdirSync(VAR_DIR, { recursive: true });

function loadOrCreateCodecKey() {
  const keyPath = join(VAR_DIR, "key.hex");
  let hex;
  if (existsSync(keyPath)) {
    hex = readFileSync(keyPath, "utf8").trim();
  } else {
    hex = randomBytes(32).toString("hex");
    writeFileSync(keyPath, hex, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
  }
  return crypto.subtle.importKey("raw", Buffer.from(hex, "hex"), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

const storeFile = join(VAR_DIR, "installations.json");
function readRecords() {
  if (!existsSync(storeFile)) return {};
  return JSON.parse(readFileSync(storeFile, "utf8"));
}
function writeRecords(records) {
  writeFileSync(storeFile, JSON.stringify(records, null, 2), { mode: 0o600 });
  chmodSync(storeFile, 0o600);
}
const storeKey = (workspaceId, addonId) => `${workspaceId}:${addonId}`;

const jsonFileStore = {
  async load(workspaceId, addonId) {
    return readRecords()[storeKey(workspaceId, addonId)] ?? null;
  },
  async save(context) {
    const records = readRecords();
    const key = storeKey(context.workspaceId, context.addonId);
    const current = records[key];
    if (current && current.installedAt > context.installedAt) return; // SDK generation semantics
    records[key] = context;
    writeRecords(records);
  },
  async delete(input) {
    const records = readRecords();
    const key = storeKey(input.workspaceId, input.addonId);
    const current = records[key];
    if (!current) return "missing";
    if (input.installedAt !== undefined && input.installedAt !== current.installedAt)
      return "stale";
    delete records[key];
    writeRecords(records);
    return "deleted";
  },
};

const codec = createClockifyAesGcmTokenCodec(await loadOrCreateCodecKey());
export const installations = wrapClockifyInstallationStoreWithEncryption(jsonFileStore, codec);
