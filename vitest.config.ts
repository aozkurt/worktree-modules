import { defineConfig } from "vitest/config";

// The tests make real repositories and worktrees, and git is slow to start on Windows.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
