import { configDefaults, defineConfig } from "vitest/config";

// The npm scripts pass directory names as filename filters (substring matches), so anything under
// the repository root whose path contains "tests/unit" would otherwise be collected — including a
// checked-out git worktree under .claude/. Excluding it keeps a test run's file list equal to this
// repository's own suite, which is what the gates claim to measure.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".claude/**", "tools/**"],
  },
});
