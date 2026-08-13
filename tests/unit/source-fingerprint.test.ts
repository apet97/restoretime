import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCleanGitCandidate,
  releaseCandidateSourceFingerprint,
  sourceFingerprint,
  sourceFingerprintFromGit,
} from "../../scripts/source-fingerprint.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repositoryFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "restoretime-source-fingerprint-test-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  for (const path of [
    ".dockerignore",
    "Dockerfile",
    "package-lock.json",
    "package.json",
    "scripts/source-fingerprint.mjs",
    "tsconfig.build.json",
    "tsconfig.json",
    "src/a.ts",
    "src/nested/b.ts",
  ]) {
    writeFileSync(join(root, path), `${path}\n`);
  }
  return root;
}

describe("runtime source fingerprint", () => {
  it("is stable when the runtime inputs do not change", () => {
    const root = repositoryFixture();
    expect(sourceFingerprint(root)).toBe(sourceFingerprint(root));
    expect(sourceFingerprint(root)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a nested runtime source file changes", () => {
    const root = repositoryFixture();
    const before = sourceFingerprint(root);
    writeFileSync(join(root, "src", "nested", "b.ts"), "changed\n");
    expect(sourceFingerprint(root)).not.toBe(before);
  });

  it("uses the named Git commit instead of dirty working files", () => {
    const root = repositoryFixture();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.name=RestoreTime Test", "-c", "user.email=restoretime-test@example.invalid", "commit", "--quiet", "-m", "fixture"],
      { cwd: root },
    );
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const committed = sourceFingerprintFromGit(candidate, root);
    expect(committed).toBe(sourceFingerprint(root));

    writeFileSync(join(root, "src", "a.ts"), "dirty upload\n");
    expect(sourceFingerprintFromGit(candidate, root)).toBe(committed);
    expect(sourceFingerprint(root)).not.toBe(committed);
  });

  it("requires the named commit and a clean checkout", () => {
    const root = repositoryFixture();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.name=RestoreTime Test", "-c", "user.email=restoretime-test@example.invalid", "commit", "--quiet", "-m", "fixture"],
      { cwd: root },
    );
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(() => assertCleanGitCandidate(candidate, root)).not.toThrow();
    expect(() => assertCleanGitCandidate("0".repeat(40), root)).toThrow(/HEAD/);

    writeFileSync(join(root, "src", "a.ts"), "dirty upload\n");
    expect(() => assertCleanGitCandidate(candidate, root)).toThrow(/not clean/);
  });

  it("binds a release only to the clean named candidate", () => {
    const root = repositoryFixture();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.name=RestoreTime Test", "-c", "user.email=restoretime-test@example.invalid", "commit", "--quiet", "-m", "fixture"],
      { cwd: root },
    );
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(releaseCandidateSourceFingerprint(candidate, root)).toBe(sourceFingerprintFromGit(candidate, root));

    writeFileSync(join(root, "src", "a.ts"), "dirty upload\n");
    expect(() => releaseCandidateSourceFingerprint(candidate, root)).toThrow(/not clean/);
  });
});
