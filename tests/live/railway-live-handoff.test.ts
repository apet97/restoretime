import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClockifyAesGcmTokenCodec } from "@apet97/clockify-addon-sdk/clockify";
import { afterEach, describe, expect, it } from "vitest";
import { importTokenEncryptionKey } from "../../src/platform/installations.js";
import { openDatabase } from "../../src/store/db.js";
import { sourceFingerprint } from "../../scripts/source-fingerprint.mjs";

const temporaryDirectories: string[] = [];
const handoffPath = fileURLToPath(new URL("../../scripts/railway-live-handoff.mjs", import.meta.url));
const repositoryPath = fileURLToPath(new URL("../..", import.meta.url));

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function addonJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: "test", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "clockify",
    sub: "restoretime",
    type: "addon",
    workspaceId: "ws-exact",
    addonId: "addon-exact",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString("base64url");
  return `${header}.${payload}.test-signature`;
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "restoretime-railway-handoff-test-"));
  temporaryDirectories.push(directory);
  const transferRoot = join(directory, "transfers");
  mkdirSync(transferRoot);
  const volumeRoot = join(directory, "remote-volume");
  mkdirSync(volumeRoot);
  const databasePath = join(volumeRoot, "restoretime.sqlite");
  const fingerprintPath = join(directory, "source-fingerprint");
  writeFileSync(fingerprintPath, `${sourceFingerprint(repositoryPath)}\n`);
  const keyHex = "4d".repeat(32);
  const token = addonJwt();
  const codec = createClockifyAesGcmTokenCodec(await importTokenEncryptionKey(keyHex));
  const db = openDatabase(databasePath);
  db.prepare(`
    INSERT INTO installations
      (workspace_id, addon_id, addon_user_id, as_user, api_url, auth_token, status, installed_at)
    VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
  `).run(
    "ws-exact",
    "addon-exact",
    "addon-user",
    "acting-user",
    "https://developer.clockify.me/api",
    await codec.encode(token),
    1,
  );
  db.close();

  const fakeRailway = join(directory, "railway-fake.mjs");
  writeFileSync(fakeRailway, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const expected = [
  "ssh",
  "--project", process.env.RT_EXPECT_PROJECT,
  "--environment", process.env.RT_EXPECT_ENVIRONMENT,
  "--service", process.env.RT_EXPECT_SERVICE,
  "--deployment-instance", process.env.RT_EXPECT_DEPLOYMENT_INSTANCE,
];
if (expected.some((value, index) => args[index] !== value)) process.exit(91);
const remoteEnvironment = {
    ...process.env,
    RAILWAY_PROJECT_ID: process.env.RT_TEST_REMOTE_PROJECT_ID || process.env.RT_EXPECT_PROJECT,
    RAILWAY_ENVIRONMENT_ID: process.env.RT_EXPECT_ENVIRONMENT,
    RAILWAY_SERVICE_ID: process.env.RT_EXPECT_SERVICE,
    RAILWAY_DEPLOYMENT_ID: process.env.RT_TEST_REMOTE_DEPLOYMENT_ID || process.env.RT_EXPECT_DEPLOYMENT,
    RAILWAY_REPLICA_ID: "replica-1",
    RAILWAY_VOLUME_MOUNT_PATH: process.env.RT_TEST_REMOTE_VOLUME,
    RAILWAY_GIT_COMMIT_SHA: process.env.RT_EXPECT_CANDIDATE,
    RESTORETIME_CANDIDATE_ID: process.env.RT_TEST_REMOTE_CANDIDATE_ID || process.env.RT_EXPECT_CANDIDATE,
    PUBLIC_BASE_URL: process.env.RT_EXPECT_BASE_URL,
    ADDON_KEY: "restoretime",
    DATABASE_PATH: process.env.RT_TEST_REMOTE_DATABASE,
    TOKEN_ENCRYPTION_KEY: process.env.RT_TEST_REMOTE_KEY,
};
if (process.env.RT_TEST_OMIT_REMOTE_CANDIDATE === "1") delete remoteEnvironment.RESTORETIME_CANDIDATE_ID;
const fingerprintPath = process.env.RT_TEST_OMIT_SOURCE_FINGERPRINT === "1"
  ? process.env.RT_TEST_MISSING_SOURCE_FINGERPRINT_PATH
  : process.env.RT_TEST_SOURCE_FINGERPRINT_PATH;
const remoteArgs = args.slice(10);
const originalRemoteSource = remoteArgs[2];
remoteArgs[2] = remoteArgs[2].replace(
  'const fingerprintPath = "/app/.restoretime-source-fingerprint";',
  'const fingerprintPath = ' + JSON.stringify(fingerprintPath) + ';',
);
if (remoteArgs[2] === originalRemoteSource) process.exit(92);
const remote = spawnSync(args[9], remoteArgs, {
  cwd: process.env.RT_TEST_REPO,
  encoding: "utf8",
  env: remoteEnvironment,
});
if (remote.stdout) process.stdout.write(remote.stdout);
if (remote.stderr) process.stderr.write(remote.stderr);
process.exit(remote.status ?? 1);
`, { mode: 0o700 });
  chmodSync(fakeRailway, 0o700);

  const candidate = "a".repeat(40);
  const expectedHash = createHash("sha256").update(token).digest("hex");
  const childProgram = `
    const { createHash } = require("node:crypto");
    const { readdirSync } = require("node:fs");
    const token = process.env.CK_LIVE_ADDON_TOKEN || "";
    if (createHash("sha256").update(token).digest("hex") !== process.env.RT_EXPECT_TOKEN_SHA256) process.exit(41);
    if (process.env.CK_DEV_ADDON_TOKEN !== token) process.exit(42);
    if (process.env.CK_DEV_WORKSPACE_ID !== "ws-exact" || process.env.CK_DEV_ADDON_ID !== "addon-exact") process.exit(43);
    if (process.env.CK_LIVE_INSTALLATION_SOURCE !== "railway-handoff") process.exit(44);
    if (process.env.CK_LIVE_HANDOFF_PROJECT_ID !== "project-1") process.exit(45);
    if (process.env.CK_LIVE_HANDOFF_ENVIRONMENT_ID !== "environment-1") process.exit(46);
    if (process.env.CK_LIVE_HANDOFF_SERVICE_ID !== "service-1") process.exit(47);
    if (process.env.CK_LIVE_HANDOFF_DEPLOYMENT_ID !== "deployment-1") process.exit(48);
    if (process.env.CK_LIVE_HANDOFF_DEPLOYMENT_INSTANCE_ID !== "instance-1") process.exit(49);
    if (readdirSync(process.env.TMPDIR).length !== 0) process.exit(50);
    process.stdout.write("child received candidate-bound installation\\n");
  `;
  const harnessPath = join(directory, "handoff-harness.mjs");
  writeFileSync(harnessPath, `
import { main } from ${JSON.stringify(pathToFileURL(handoffPath).href)};
process.exitCode = await main(
  [process.execPath, "-e", process.env.RT_TEST_CHILD_PROGRAM],
  {
    railwayBin: process.env.RT_TEST_RAILWAY_BIN,
    volumeMountPath: process.env.RT_TEST_RAILWAY_VOLUME_MOUNT_PATH,
    bindCandidate: () => process.env.RT_EXPECT_SOURCE_FINGERPRINT,
  },
);
`);
  const env = {
    ...process.env,
    NODE_ENV: "test",
    TMPDIR: transferRoot,
    RT_TEST_RAILWAY_BIN: fakeRailway,
    RT_TEST_RAILWAY_VOLUME_MOUNT_PATH: volumeRoot,
    RT_TEST_REPO: repositoryPath,
    RT_TEST_REMOTE_VOLUME: volumeRoot,
    RT_TEST_REMOTE_DATABASE: databasePath,
    RT_TEST_REMOTE_KEY: keyHex,
    RT_TEST_SOURCE_FINGERPRINT_PATH: fingerprintPath,
    RT_TEST_MISSING_SOURCE_FINGERPRINT_PATH: join(directory, "missing-source-fingerprint"),
    RT_TEST_CHILD_PROGRAM: childProgram,
    RT_EXPECT_PROJECT: "project-1",
    RT_EXPECT_ENVIRONMENT: "environment-1",
    RT_EXPECT_SERVICE: "service-1",
    RT_EXPECT_DEPLOYMENT: "deployment-1",
    RT_EXPECT_DEPLOYMENT_INSTANCE: "instance-1",
    RT_EXPECT_CANDIDATE: candidate,
    RT_EXPECT_BASE_URL: "https://restoretime.example.up.railway.app",
    RT_EXPECT_TOKEN_SHA256: expectedHash,
    RT_EXPECT_SOURCE_FINGERPRINT: sourceFingerprint(repositoryPath),
    CK_LIVE_TARGET: "developer",
    CK_LIVE_API_BASE: "https://developer.clockify.me/api",
    CK_LIVE_ADDON_BASE_URL: "https://restoretime.example.up.railway.app",
    CK_LIVE_CANDIDATE_ID: candidate,
    CK_LIVE_WS: "ws-exact",
    CK_LIVE_ADDON_ID: "addon-exact",
    CK_LIVE_ADDON_KEY: "restoretime",
    CK_RAILWAY_PROJECT_ID: "project-1",
    CK_RAILWAY_ENVIRONMENT_ID: "environment-1",
    CK_RAILWAY_SERVICE_ID: "service-1",
    CK_RAILWAY_DEPLOYMENT_ID: "deployment-1",
    CK_RAILWAY_DEPLOYMENT_INSTANCE_ID: "instance-1",
  };
  return { env, fingerprintPath, harnessPath, token, transferRoot };
}

function runHandoff(harnessPath: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [harnessPath], { encoding: "utf8", env });
}

function gitCandidateFixture(directory: string): { candidate: string; root: string } {
  const root = join(directory, "candidate");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "src"));
  for (const path of [
    ".dockerignore",
    "Dockerfile",
    "package-lock.json",
    "package.json",
    "scripts/source-fingerprint.mjs",
    "tsconfig.build.json",
    "tsconfig.json",
    "src/server.ts",
  ]) {
    writeFileSync(join(root, path), `${path}\n`);
  }
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=RestoreTime Test", "-c", "user.email=restoretime-test@example.invalid", "commit", "--quiet", "-m", "candidate"],
    { cwd: root },
  );
  return {
    candidate: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    root,
  };
}

describe("candidate-bound Railway installation handoff", () => {
  it("uses the production candidate binder and rejects a dirty checkout", async () => {
    const { env, harnessPath, token, transferRoot } = await fixture();
    const { candidate, root } = gitCandidateFixture(join(harnessPath, ".."));
    writeFileSync(join(root, "src", "server.ts"), "dirty upload\n");
    const productionHarness = join(harnessPath, "..", "production-binding-harness.mjs");
    writeFileSync(productionHarness, `
import { main } from ${JSON.stringify(pathToFileURL(handoffPath).href)};
process.exitCode = await main(
  [process.execPath, "-e", "process.exit(90)"],
  {
    railwayBin: process.env.RT_TEST_RAILWAY_BIN,
    repositoryRoot: process.env.RT_TEST_CANDIDATE_REPOSITORY,
    volumeMountPath: process.env.RT_TEST_RAILWAY_VOLUME_MOUNT_PATH,
  },
);
`);
    const result = runHandoff(productionHarness, {
      ...env,
      CK_LIVE_CANDIDATE_ID: candidate,
      RT_TEST_CANDIDATE_REPOSITORY: root,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/local candidate checkout is not clean/);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(readdirSync(transferRoot)).toEqual([]);
  });

  it("passes the remote token only to the child and creates no transfer file", async () => {
    const { env, harnessPath, token, transferRoot } = await fixture();
    const result = runHandoff(harnessPath, env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("child received candidate-bound installation\n");
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(readdirSync(transferRoot)).toEqual([]);
  });

  it("rejects a different remote deployment and creates no transfer file", async () => {
    const { env, harnessPath, token, transferRoot } = await fixture();
    const result = runHandoff(harnessPath, { ...env, RT_TEST_REMOTE_DEPLOYMENT_ID: "older-deployment" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Railway SSH installation handoff failed/);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(readdirSync(transferRoot)).toEqual([]);
  });

  it("rejects a deployment that omits RESTORETIME_CANDIDATE_ID", async () => {
    const { env, harnessPath, token, transferRoot } = await fixture();
    const result = runHandoff(harnessPath, { ...env, RT_TEST_OMIT_REMOTE_CANDIDATE: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Railway SSH installation handoff failed/);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(readdirSync(transferRoot)).toEqual([]);
  });

  it("rejects RESTORETIME_CANDIDATE_ID when it does not match the local candidate", async () => {
    const { env, harnessPath, token, transferRoot } = await fixture();
    const result = runHandoff(harnessPath, { ...env, RT_TEST_REMOTE_CANDIDATE_ID: "b".repeat(40) });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Railway SSH installation handoff failed/);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(readdirSync(transferRoot)).toEqual([]);
  });

  it("rejects a deployment that has no source fingerprint", async () => {
    const { env, harnessPath, token, transferRoot } = await fixture();
    const result = runHandoff(harnessPath, { ...env, RT_TEST_OMIT_SOURCE_FINGERPRINT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Railway SSH installation handoff failed/);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(readdirSync(transferRoot)).toEqual([]);
  });

  it("rejects a deployment whose source fingerprint differs", async () => {
    const { env, fingerprintPath, harnessPath, token, transferRoot } = await fixture();
    writeFileSync(fingerprintPath, `${"0".repeat(64)}\n`);
    const result = runHandoff(harnessPath, env);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Railway SSH installation handoff failed/);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(readdirSync(transferRoot)).toEqual([]);
  });
});
