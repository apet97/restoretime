import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Docker release source binding", () => {
  it("pins the supported Node runtime across local and container setup", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      engines: { node: string };
    };
    const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");

    expect(readFileSync(join(process.cwd(), ".nvmrc"), "utf8").trim()).toBe("22");
    expect(packageJson.engines.node).toBe(">=22.13.0 <23");
    expect(readFileSync(join(process.cwd(), ".npmrc"), "utf8").trim()).toBe("engine-strict=true");
    expect(dockerfile).toContain("node:22-bookworm-slim@");
  });

  it("generates the application source fingerprint during the build and copies it into runtime", () => {
    const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
    const pinnedBase =
      "node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436";
    expect(dockerfile.match(new RegExp(`FROM ${pinnedBase}`, "g"))).toHaveLength(3);
    expect(dockerfile).toContain("COPY scripts/source-fingerprint.mjs ./scripts/source-fingerprint.mjs");
    expect(dockerfile).toContain("RUN node scripts/source-fingerprint.mjs > /tmp/restoretime-source-fingerprint");
    expect(dockerfile).toContain(
      "COPY --from=builder /tmp/restoretime-source-fingerprint ./.restoretime-source-fingerprint",
    );
    expect(dockerfile).toContain("RUN mkdir -p /data && chown node:node /data");
    expect(dockerfile).not.toContain('VOLUME ["/data"]');
    expect(dockerfile).not.toContain("chown -R node:node /app");
    expect(dockerfile).toContain("rm -rf /usr/local/lib/node_modules/npm");
    expect(dockerfile).toContain("/usr/local/lib/node_modules/corepack");
    expect(dockerfile).toContain("/opt/yarn-v1.22.22");
  });

  it("rejects test overrides before the live release handoff", () => {
    const directory = mkdtempSync(join(tmpdir(), "restoretime-live-env-contract-"));
    try {
      mkdirSync(join(directory, "scripts"));
      writeFileSync(join(directory, ".env.live"), "CK_LIVE_TARGET=developer\n");
      writeFileSync(
        join(directory, "scripts", "live-env.sh"),
        readFileSync(join(process.cwd(), "scripts", "live-env.sh"), "utf8"),
      );
      const result = spawnSync(
        "bash",
        [join(directory, "scripts", "live-env.sh"), "https://restoretime.example.invalid", "true"],
        {
          encoding: "utf8",
          env: { ...process.env, NODE_ENV: "", RT_TEST_SENTINEL: "1" },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/test environment overrides are not accepted/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
