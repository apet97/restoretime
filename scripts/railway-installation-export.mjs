// This program runs through `railway ssh` inside one deployed RestoreTime container. The local
// handoff tool sends this source to `node --eval`; the runtime image does not need a second copy.
// It returns one hybrid-encrypted envelope. It never prints the installation token.
import Database from "better-sqlite3";
import { createClockifyAesGcmTokenCodec } from "@apet97/clockify-addon-sdk/clockify";
import {
  createCipheriv,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  webcrypto,
} from "node:crypto";
import { resolve } from "node:path";

const OUTPUT_PREFIX = "RESTORETIME_RAILWAY_HANDOFF_V1:";

function reject() {
  // Keep the remote error generic. The local tool must not relay a remote error that could include
  // configuration or token material.
  process.stderr.write("RestoreTime Railway handoff rejected the request.\n");
  process.exit(1);
}

function exact(name, expected) {
  if (typeof expected !== "string" || expected === "" || process.env[name] !== expected) reject();
}

function normalizedOrigin(value) {
  if (typeof value !== "string") reject();
  let url;
  try {
    url = new URL(value);
  } catch {
    reject();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) reject();
  return url.origin;
}

try {
  const encodedRequest = process.argv[1];
  if (!encodedRequest) reject();
  const request = JSON.parse(Buffer.from(encodedRequest, "base64url").toString("utf8"));
  if (request?.schemaVersion !== 1 || typeof request.handoffId !== "string" || request.handoffId.length < 32) reject();

  exact("RAILWAY_PROJECT_ID", request.projectId);
  exact("RAILWAY_ENVIRONMENT_ID", request.environmentId);
  exact("RAILWAY_SERVICE_ID", request.serviceId);
  exact("RAILWAY_DEPLOYMENT_ID", request.deploymentId);
  exact("RAILWAY_VOLUME_MOUNT_PATH", request.volumeMountPath);
  exact("RESTORETIME_CANDIDATE_ID", request.candidateId);
  exact("ADDON_KEY", request.addonKey);
  if (process.env.RAILWAY_GIT_COMMIT_SHA && process.env.RAILWAY_GIT_COMMIT_SHA !== request.candidateId) reject();
  if (!process.env.RAILWAY_REPLICA_ID) reject();
  if (normalizedOrigin(process.env.PUBLIC_BASE_URL) !== request.addonBaseUrl) reject();

  const databasePath = process.env.DATABASE_PATH;
  const keyHex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!databasePath || !keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) reject();
  const volumeRoot = resolve(request.volumeMountPath);
  const resolvedDatabase = resolve(databasePath);
  if (resolvedDatabase === volumeRoot || !resolvedDatabase.startsWith(`${volumeRoot}/`)) reject();

  const db = new Database(resolvedDatabase, { readonly: true, fileMustExist: true });
  let rows;
  try {
    rows = db.prepare(
      "SELECT workspace_id, addon_id, api_url, auth_token, status FROM installations WHERE workspace_id = ? AND addon_id = ?",
    ).all(request.workspaceId, request.addonId);
  } finally {
    db.close();
  }
  if (rows.length !== 1) reject();
  const row = rows[0];
  if (row.status !== "ACTIVE" || String(row.api_url).replace(/\/+$/, "") !== request.apiUrl) reject();

  const storageKey = await webcrypto.subtle.importKey(
    "raw",
    Buffer.from(keyHex, "hex"),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  const addonToken = await createClockifyAesGcmTokenCodec(storageKey).decode(row.auth_token);
  if (!addonToken) reject();

  const binding = {
    schemaVersion: 1,
    handoffId: request.handoffId,
    projectId: request.projectId,
    environmentId: request.environmentId,
    serviceId: request.serviceId,
    deploymentId: request.deploymentId,
    deploymentInstanceId: request.deploymentInstanceId,
    replicaId: process.env.RAILWAY_REPLICA_ID,
    candidateId: request.candidateId,
    workspaceId: row.workspace_id,
    addonId: row.addon_id,
    addonKey: request.addonKey,
    apiUrl: String(row.api_url).replace(/\/+$/, ""),
    addonBaseUrl: request.addonBaseUrl,
  };
  const plaintext = Buffer.from(JSON.stringify({ ...binding, addonToken }), "utf8");
  const transferKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", transferKey, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(binding), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const publicKey = createPublicKey({
    key: Buffer.from(request.publicKey, "base64url"),
    format: "der",
    type: "spki",
  });
  const wrappedKey = publicEncrypt({ key: publicKey, oaepHash: "sha256" }, transferKey);
  transferKey.fill(0);
  plaintext.fill(0);

  process.stdout.write(`${OUTPUT_PREFIX}${JSON.stringify({
    schemaVersion: 1,
    algorithm: "RSA-OAEP-256+A256GCM",
    binding,
    wrappedKey: wrappedKey.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  })}\n`);
} catch {
  reject();
}
