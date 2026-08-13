// Produce one deterministic fingerprint for every file that can change the RestoreTime runtime
// image. A Railway CLI upload has no Git commit system variable, so the release handoff compares
// the named Git commit with the fingerprint baked from the uploaded files into the deployed image.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FILES = [
  ".dockerignore",
  "Dockerfile",
  "package-lock.json",
  "package.json",
  "scripts/source-fingerprint.mjs",
  "tsconfig.build.json",
  "tsconfig.json",
];

function sourceFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`source fingerprint does not accept a non-file entry: ${path}`);
    }
  }
  visit(resolve(root, "src"));
  return files;
}

function fingerprint(entries) {
  const hash = createHash("sha256");
  for (const [name, content] of entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    hash.update(`${Buffer.byteLength(name)}:${name}:${content.length}:`, "utf8");
    hash.update(content);
  }
  return hash.digest("hex");
}

export function sourceFingerprint(root = process.cwd()) {
  const repositoryRoot = resolve(root);
  const paths = [...ROOT_FILES.map((path) => resolve(repositoryRoot, path)), ...sourceFiles(repositoryRoot)];
  return fingerprint(paths.map((path) => {
    if (!lstatSync(path).isFile()) throw new Error(`source fingerprint input is not a file: ${path}`);
    return [relative(repositoryRoot, path).split(sep).join("/"), readFileSync(path)];
  }));
}

export function sourceFingerprintFromGit(candidateId, root = process.cwd()) {
  if (!/^[0-9a-fA-F]{40}$/.test(candidateId)) throw new Error("source fingerprint requires a full Git commit");
  const repositoryRoot = resolve(root);
  const sourceNames = execFileSync(
    "git",
    ["-C", repositoryRoot, "ls-tree", "-r", "--name-only", candidateId, "--", "src"],
    { encoding: "utf8" },
  ).trim().split("\n").filter(Boolean);
  const names = [...ROOT_FILES, ...sourceNames];
  return fingerprint(names.map((name) => [
    name,
    execFileSync("git", ["-C", repositoryRoot, "show", `${candidateId}:${name}`], { maxBuffer: 16 * 1024 * 1024 }),
  ]));
}

export function assertCleanGitCandidate(candidateId, root = process.cwd()) {
  if (!/^[0-9a-fA-F]{40}$/.test(candidateId)) throw new Error("candidate checkout requires a full Git commit");
  const repositoryRoot = resolve(root);
  const head = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head.toLowerCase() !== candidateId.toLowerCase()) {
    throw new Error("the local checkout HEAD does not match CK_LIVE_CANDIDATE_ID");
  }
  const status = execFileSync(
    "git",
    ["-C", repositoryRoot, "status", "--porcelain", "--untracked-files=all"],
    { encoding: "utf8" },
  );
  if (status !== "") throw new Error("the local candidate checkout is not clean");
}

export function releaseCandidateSourceFingerprint(candidateId, root = process.cwd()) {
  assertCleanGitCandidate(candidateId, root);
  return sourceFingerprintFromGit(candidateId, root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${sourceFingerprint()}\n`);
}
