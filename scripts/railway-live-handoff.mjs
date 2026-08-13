// Obtains one exact installation from one exact Railway deployment and starts a local command with
// the installation token in its child environment. The remote side returns only ciphertext. The
// plaintext token stays in process memory and is never printed or written to a file.
import { spawn, spawnSync } from "node:child_process";
import {
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseCandidateSourceFingerprint } from "./source-fingerprint.mjs";

const OUTPUT_PREFIX = "RESTORETIME_RAILWAY_HANDOFF_V1:";
const DEVELOPER_API_URL = "https://developer.clockify.me/api";

function fail(message) {
  throw new Error(message);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`missing ${name} for the Railway installation handoff`);
  return value;
}

function exactHttpsOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("CK_LIVE_ADDON_BASE_URL must be a valid HTTPS origin");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    fail("CK_LIVE_ADDON_BASE_URL must be an HTTPS origin with no path, query, fragment, or credentials");
  }
  return url.origin;
}

function parseEnvelope(rawOutput) {
  const matches = rawOutput.split(/\r?\n/).filter((line) => line.startsWith(OUTPUT_PREFIX));
  if (matches.length !== 1) fail("the Railway deployment did not return one encrypted installation envelope");
  let envelope;
  try {
    envelope = JSON.parse(matches[0].slice(OUTPUT_PREFIX.length));
  } catch {
    fail("the Railway deployment returned an invalid encrypted installation envelope");
  }
  if (envelope?.schemaVersion !== 1 || envelope.algorithm !== "RSA-OAEP-256+A256GCM") {
    fail("the Railway deployment returned an unsupported encrypted installation envelope");
  }
  return envelope;
}

function assertBinding(actual, expected) {
  for (const [field, value] of Object.entries(expected)) {
    if (actual?.[field] !== value) fail(`the Railway installation handoff does not match ${field}`);
  }
  if (typeof actual.replicaId !== "string" || actual.replicaId === "") {
    fail("the Railway installation handoff has no replica identity");
  }
}

async function runChild(command, args, environment) {
  const child = spawn(command, args, { env: environment, stdio: "inherit" });
  return await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const [command, ...args] = argv;
  if (!command) fail("usage: node scripts/railway-live-handoff.mjs <command> [args...]");
  if (required("CK_LIVE_TARGET") !== "developer") fail("CK_LIVE_TARGET must be developer");
  if (required("CK_LIVE_API_BASE").replace(/\/+$/, "") !== DEVELOPER_API_URL) {
    fail(`CK_LIVE_API_BASE must be ${DEVELOPER_API_URL}`);
  }

  const candidateId = required("CK_LIVE_CANDIDATE_ID");
  if (!/^[0-9a-fA-F]{40}$/.test(candidateId)) {
    fail("CK_LIVE_CANDIDATE_ID must be the full 40-character merged Git commit");
  }
  const addonBaseUrl = exactHttpsOrigin(required("CK_LIVE_ADDON_BASE_URL"));
  const projectId = required("CK_RAILWAY_PROJECT_ID");
  const environmentId = required("CK_RAILWAY_ENVIRONMENT_ID");
  const serviceId = required("CK_RAILWAY_SERVICE_ID");
  const deploymentId = required("CK_RAILWAY_DEPLOYMENT_ID");
  const deploymentInstanceId = required("CK_RAILWAY_DEPLOYMENT_INSTANCE_ID");
  const volumeMountPath = dependencies.volumeMountPath ? resolve(dependencies.volumeMountPath) : "/data";
  const repositoryRoot = dependencies.repositoryRoot ?? fileURLToPath(new URL("..", import.meta.url));
  const bindCandidate = dependencies.bindCandidate ?? releaseCandidateSourceFingerprint;
  const expectedSourceFingerprint = bindCandidate(candidateId, repositoryRoot);
  const request = {
    schemaVersion: 1,
    handoffId: randomBytes(32).toString("hex"),
    projectId,
    environmentId,
    serviceId,
    deploymentId,
    deploymentInstanceId,
    candidateId,
    sourceFingerprint: expectedSourceFingerprint,
    workspaceId: required("CK_LIVE_WS"),
    addonId: required("CK_LIVE_ADDON_ID"),
    addonKey: required("CK_LIVE_ADDON_KEY"),
    apiUrl: DEVELOPER_API_URL,
    addonBaseUrl,
    volumeMountPath,
  };
  const binding = {
    schemaVersion: request.schemaVersion,
    handoffId: request.handoffId,
    projectId: request.projectId,
    environmentId: request.environmentId,
    serviceId: request.serviceId,
    deploymentId: request.deploymentId,
    deploymentInstanceId: request.deploymentInstanceId,
    candidateId: request.candidateId,
    sourceFingerprint: request.sourceFingerprint,
    workspaceId: request.workspaceId,
    addonId: request.addonId,
    addonKey: request.addonKey,
    apiUrl: request.apiUrl,
    addonBaseUrl: request.addonBaseUrl,
  };
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  request.publicKey = publicKey.toString("base64url");

  const remoteSource = readFileSync(new URL("./railway-installation-export.mjs", import.meta.url), "utf8");
  const railwayBin = dependencies.railwayBin ?? "railway";
  const result = spawnSync(
    railwayBin,
    [
      "ssh",
      "--project",
      projectId,
      "--environment",
      environmentId,
      "--service",
      serviceId,
      "--deployment-instance",
      deploymentInstanceId,
      "node",
      "--input-type=module",
      "--eval",
      remoteSource,
      Buffer.from(JSON.stringify(request), "utf8").toString("base64url"),
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.status !== 0 || result.error) {
    fail("the Railway SSH installation handoff failed; verify the exact project, environment, service, deployment, and deployment-instance IDs");
  }

  // The encrypted envelope, decrypted payload, private key, and token stay in process memory.
  // No transfer file exists to persist or clean.
  const envelope = parseEnvelope(result.stdout);
  assertBinding(envelope.binding, binding);
  const transferKey = privateDecrypt(
    { key: privateKey, oaepHash: "sha256" },
    Buffer.from(envelope.wrappedKey, "base64url"),
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    transferKey,
    Buffer.from(envelope.iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(JSON.stringify(envelope.binding), "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]);
  transferKey.fill(0);
  let payload;
  try {
    payload = JSON.parse(decrypted.toString("utf8"));
  } finally {
    decrypted.fill(0);
  }
  assertBinding(payload, envelope.binding);
  if (typeof payload.addonToken !== "string" || payload.addonToken === "") {
    fail("the Railway installation handoff returned no installation token");
  }
  if (`${result.stdout}${result.stderr}`.includes(payload.addonToken)) {
    fail("the Railway installation handoff exposed a plaintext token outside the encrypted envelope");
  }

  const childEnvironment = {
    ...process.env,
    CK_LIVE_ADDON_TOKEN: payload.addonToken,
    CK_DEV_WORKSPACE_ID: payload.workspaceId,
    CK_DEV_ADDON_ID: payload.addonId,
    CK_DEV_ADDON_TOKEN: payload.addonToken,
    CK_LIVE_INSTALLATION_SOURCE: "railway-handoff",
    CK_LIVE_HANDOFF_PROJECT_ID: payload.projectId,
    CK_LIVE_HANDOFF_ENVIRONMENT_ID: payload.environmentId,
    CK_LIVE_HANDOFF_SERVICE_ID: payload.serviceId,
    CK_LIVE_HANDOFF_DEPLOYMENT_ID: payload.deploymentId,
    CK_LIVE_HANDOFF_DEPLOYMENT_INSTANCE_ID: payload.deploymentInstanceId,
    CK_LIVE_HANDOFF_CANDIDATE_ID: payload.candidateId,
  };
  delete childEnvironment.TOKEN_ENCRYPTION_KEY;
  delete childEnvironment.DATABASE_PATH;
  const childResult = await runChild(command, args, childEnvironment);
  if (childResult.signal) {
    process.kill(process.pid, childResult.signal);
    return 1;
  }
  return childResult.code ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Railway installation handoff failed"}\n`);
    process.exitCode = 1;
  }
}
