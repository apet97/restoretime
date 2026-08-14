import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

interface StartedServer {
  readonly child: ChildProcess;
  readonly databasePath: string;
  readonly output: () => string;
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close(() => reject(new Error("Could not reserve a local TCP port.")));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForHealthy(port: number, output: () => string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.status === 200 && JSON.stringify(await response.json()) === JSON.stringify({ status: "ok", db: "ok" })) return;
      lastError = `Health endpoint returned ${response.status}.`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become healthy: ${lastError}\n${output()}`);
}

function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server did not exit within five seconds.")), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function startServer(): Promise<StartedServer> {
  const directory = mkdtempSync(join(tmpdir(), "restoretime-shutdown-"));
  temporaryDirectories.push(directory);
  const port = await reservePort();
  const databasePath = join(directory, "restoretime.sqlite");
  const publicDummyKey = "00".repeat(32);
  let output = "";
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_BASE_URL: "https://restoretime.example.invalid",
      CLOCKIFY_PARENT_ORIGIN: "https://developer.clockify.me",
      DATABASE_PATH: databasePath,
      ADDON_KEY: "restoretime-shutdown-test",
      TOKEN_ENCRYPTION_KEY: publicDummyKey,
      LOG_LEVEL: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    output += chunk;
  });

  try {
    await waitForHealthy(port, () => output);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  expect(output).not.toContain(publicDummyKey);
  return { child, databasePath, output: () => output };
}

function expectDatabaseIntegrity(databasePath: string): void {
  const database = new Database(databasePath, { readonly: true });
  try {
    expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
  } finally {
    database.close();
  }
}

describe("production server shutdown", () => {
  it("drains on SIGTERM, exits 0, and leaves an intact SQLite database", { timeout: 12_000 }, async () => {
    const started = await startServer();
    const exit = waitForExit(started.child);
    started.child.kill("SIGTERM");

    await expect(exit).resolves.toEqual({ code: 0, signal: null });
    const output = started.output();
    expect(output.match(/"msg":"shutdown_started","signal":"SIGTERM"/g)).toHaveLength(1);
    expect(output).not.toContain("TOKEN_ENCRYPTION_KEY");
    expectDatabaseIntegrity(started.databasePath);
  });

  it("handles a second shutdown signal only once", { timeout: 12_000 }, async () => {
    const started = await startServer();
    const exit = waitForExit(started.child);
    started.child.kill("SIGTERM");
    started.child.kill("SIGTERM");

    await expect(exit).resolves.toEqual({ code: 0, signal: null });
    expect(started.output().match(/"msg":"shutdown_started","signal":"SIGTERM"/g)).toHaveLength(1);
    expectDatabaseIntegrity(started.databasePath);
  });
});
