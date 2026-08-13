// Run the strict scenario process, inspect its summary, and always run the separate cleanup
// process. A Node orchestrator keeps this gate portable across macOS /bin/sh and Linux dash.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const vitest = "node_modules/vitest/vitest.mjs";
const environment = { ...process.env, CK_LIVE_STRICT: "1" };

const SECRET_ENV_NAME = /(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ENCRYPTION_KEY)/i;

/** Remove exact secret values before any child output reaches the terminal. */
export function redactLiveSecrets(rawOutput, childEnvironment) {
  const byValue = new Map();
  for (const [name, value] of Object.entries(childEnvironment)) {
    if (!SECRET_ENV_NAME.test(name) || typeof value !== "string" || value === "") continue;
    const names = byValue.get(value) ?? [];
    names.push(name);
    byValue.set(value, names);
  }
  let output = rawOutput;
  const leakedSecretNames = [];
  for (const [value, names] of [...byValue.entries()].sort(([left], [right]) => right.length - left.length)) {
    if (!output.includes(value)) continue;
    leakedSecretNames.push(...names);
    output = output.split(value).join(`[REDACTED:${names.join("/")}]`);
  }
  return { output, leakedSecretNames };
}

export function inspectLiveRun(output) {
  return {
    skipped: /(?:Tests|Test Files)\s+[^\n]*?[1-9]\d* skipped/.test(output),
    incomplete: /\bPARTIAL\b|\bblocked —|^LV-[^\n]*\bSKIP(?:PED)?\b|^(?:BLOCKED|SKIP(?:PED)?)\b/im.test(output),
  };
}

function runVitest(args) {
  const result = spawnSync(process.execPath, [vitest, "run", ...args, "--no-file-parallelism"], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const rawOutput = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `live release runner failed: ${result.error.message}\n` : ""}`;
  const guarded = redactLiveSecrets(rawOutput, environment);
  if (guarded.output) process.stdout.write(guarded.output);
  if (guarded.leakedSecretNames.length > 0) {
    process.stderr.write(`release gate blocked — child output contained secret value(s) from ${[...new Set(guarded.leakedSecretNames)].join(", ")}\n`);
  }
  return {
    output: guarded.output,
    status: result.status ?? 1,
    secretLeak: guarded.leakedSecretNames.length > 0,
  };
}

function main() {
  function failsStrictGate(result) {
    const summary = inspectLiveRun(result.output);
    if (summary.skipped) process.stderr.write("release gate blocked — strict live run reported a skipped test\n");
    if (summary.incomplete) process.stderr.write("release gate blocked — strict live run reported an incomplete scenario\n");
    return result.status !== 0 || result.secretLeak || summary.skipped || summary.incomplete;
  }

  const mode = process.argv[2] ?? "release";
  if (mode === "trigger") {
    const trigger = runVitest(["tests/live/lv-02-webhook-trigger.test.ts"]);
    process.exitCode = failsStrictGate(trigger) ? 1 : 0;
    return;
  }
  if (mode === "cleanup") {
    const cleanupOnly = runVitest(["tests/live/release-cleanup.test.ts"]);
    process.exitCode = failsStrictGate(cleanupOnly) ? 1 : 0;
    return;
  }
  if (mode !== "release") {
    process.stderr.write("usage: node scripts/run-live-release.mjs [release|trigger|cleanup]\n");
    process.exitCode = 2;
    return;
  }
  const scenarios = runVitest([
    "tests/live",
    "--exclude",
    "tests/live/lv-02-webhook-trigger.test.ts",
    "--exclude",
    "tests/live/release-cleanup.test.ts",
  ]);
  const scenariosFailed = failsStrictGate(scenarios);

  // This process is separate so it runs after failed scenarios and cannot be skipped by test-file
  // teardown ordering. It needs target credentials but not candidate receipts.
  const cleanup = runVitest(["tests/live/release-cleanup.test.ts"]);
  const cleanupFailed = failsStrictGate(cleanup);

  process.exitCode = scenariosFailed || cleanupFailed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
