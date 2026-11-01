import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { add } from "../src/share.js";
import { git, junction, listFiles, tempDir, write } from "./helpers.js";

function npm(cwd: string, ...args: string[]) {
  const result = spawnSync(`npm ${args.join(" ")}`, { cwd, shell: true, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed: ${result.stdout}${result.stderr}`);
}

// A real npm, offline: the only dependency is a tarball in the repository.
function npmProject() {
  const root = tempDir();
  write(root, { "dummy/package.json": '{ "name": "dummy", "version": "1.0.0" }', "dummy/index.js": "module.exports = 42;\n" });
  const main = path.join(root, "app");
  fs.mkdirSync(main);
  npm(path.join(root, "dummy"), "pack", "--pack-destination", JSON.stringify(main), "--silent");
  write(main, {
    ".gitignore": "node_modules/\n",
    "package.json": JSON.stringify({ name: "app", version: "1.0.0", private: true, dependencies: { dummy: "file:dummy-1.0.0.tgz" } }),
  });
  npm(main, "install", "--offline", "--no-audit", "--no-fund");
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "core.autocrlf", "false");
  git(main, "add", "-A");
  git(main, "commit", "-qm", "First commit");
  write(main, { "node_modules/marker.txt": "keep me", "node_modules/extra/index.js": "keep me" });
  return { root, main, shared: () => listFiles(path.join(main, "node_modules")) };
}

describe("npm ci in a worktree", () => {
  it("empties the main checkout's node_modules through a single link", () => {
    const { root, main, shared } = npmProject();
    git(main, "worktree", "add", "-q", "../feature");
    junction(path.join(main, "node_modules"), path.join(root, "feature", "node_modules"));
    npm(path.join(root, "feature"), "ci", "--offline", "--no-audit", "--no-fund");
    // This is the trap: npm ci deletes each entry of node_modules, and through the link those are the main checkout's.
    expect(shared()).toEqual([]);
  });

  it("leaves the main checkout's packages alone after worktree-modules link", () => {
    const { root, main, shared } = npmProject();
    add(main, "../feature", { cwd: main });
    const before = shared();
    expect(before).toEqual(["dummy/index.js", "dummy/package.json", "extra/index.js", "marker.txt", ".package-lock.json"].sort());

    npm(path.join(root, "feature"), "ci", "--offline", "--no-audit", "--no-fund");

    expect(shared()).toEqual(before);
    // The worktree now has an install of its own.
    expect(fs.lstatSync(path.join(root, "feature", "node_modules", "dummy")).isSymbolicLink()).toBe(false);
  });
});
