import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { remove } from "../src/remove.js";
import { add, link } from "../src/share.js";
import { createProject, git, isLink, junction, listFiles, tempDir, write } from "./helpers.js";

function worktrees(main: string): string[] {
  return git(main, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)));
}

describe("remove", () => {
  it("removes a linked worktree and never touches what the links point to", () => {
    const { root, main, shared } = createProject();
    add(main, "../feature", { cwd: main });
    const before = shared();
    expect(before.length).toBeGreaterThan(10);

    const result = remove("../feature", { cwd: main });

    expect(result).toEqual({ ok: true, worktree: path.join(root, "feature"), unlinked: 5, method: "git", notes: [] });
    expect(fs.existsSync(path.join(root, "feature"))).toBe(false);
    expect(worktrees(main)).toEqual([main]);
    expect(shared()).toEqual(before);
  });

  it("removes a worktree whose node_modules is one link, as other tools make it", () => {
    const { root, main, shared } = createProject();
    git(main, "worktree", "add", "-q", "../feature");
    junction(path.join(main, "node_modules"), path.join(root, "feature", "node_modules"));
    const before = shared();

    expect(remove(path.join(root, "feature"), { cwd: main })).toMatchObject({ ok: true, unlinked: 1 });
    expect(shared()).toEqual(before);
  });

  it("takes out links anywhere in the worktree", () => {
    const { root, main, shared } = createProject();
    add(main, "../feature", { cwd: main });
    const outside = path.join(root, "assets");
    write(outside, { "logo.svg": "<svg/>", "fonts/inter.woff2": "font" });
    junction(outside, path.join(root, "feature", "public", "assets"));
    junction(outside, path.join(root, "feature", "node_modules", ".cache", "deep", "assets"));
    const before = shared();

    const result = remove("../feature", { cwd: main, force: true });

    expect(result.unlinked).toBe(7);
    expect(listFiles(outside)).toEqual(["fonts/inter.woff2", "logo.svg"]);
    expect(shared()).toEqual(before);
  });

  it("deletes paths longer than 260 characters", () => {
    const { root, main, shared } = createProject();
    add(main, "../feature", { cwd: main });
    let deep = path.join(root, "feature", "node_modules", ".cache", "plugin", "android", "build", "intermediates");
    while (deep.length < 320) deep = path.join(deep, "a-long-folder-name-from-a-gradle-build");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "classes.jar"), "jar");
    const before = shared();

    expect(remove("../feature", { cwd: main }).ok).toBe(true);
    expect(fs.existsSync(path.join(root, "feature"))).toBe(false);
    expect(worktrees(main)).toEqual([main]);
    expect(shared()).toEqual(before);
  });

  it("deletes read-only files", () => {
    const { root, main } = createProject();
    git(main, "worktree", "add", "-q", "../feature");
    const file = path.join(root, "feature", "android", "build.gradle");
    fs.chmodSync(file, 0o444);
    expect(remove("../feature", { cwd: main }).ok).toBe(true);
    expect(fs.existsSync(path.join(root, "feature"))).toBe(false);
  });

  it("keeps a worktree with changes unless --force", () => {
    const { root, main, shared } = createProject();
    add(main, "../feature", { cwd: main });
    write(path.join(root, "feature"), { "src/main.js": "changed\n", "src/new.js": "new\n" });
    const before = shared();

    expect(() => remove("../feature", { cwd: main })).toThrow(/has changes, so it stays \(--force removes it anyway\):\n {3}M src\/main\.js\n {2}\?\? src\/new\.js/);
    // Nothing was taken out.
    expect(isLink(path.join(root, "feature", "node_modules", "react"))).toBe(true);

    expect(remove("../feature", { cwd: main, force: true }).ok).toBe(true);
    expect(fs.existsSync(path.join(root, "feature"))).toBe(false);
    expect(shared()).toEqual(before);
  });

  it("forgets a worktree whose folder is gone", () => {
    const { root, main } = createProject();
    git(main, "worktree", "add", "-q", "../feature");
    fs.rmSync(path.join(root, "feature"), { recursive: true, force: true });
    expect(remove("../feature", { cwd: main })).toMatchObject({ ok: true, method: "prune", unlinked: 0 });
    expect(worktrees(main)).toEqual([main]);
  });

  it("refuses the main checkout and folders that are not worktrees", () => {
    const { root, main } = createProject();
    expect(() => remove(".", { cwd: main })).toThrow(/is the main checkout/);
    expect(() => remove("src", { cwd: main })).toThrow(/src is not a worktree of this repository/);
    fs.mkdirSync(path.join(root, "other"));
    expect(() => remove("../other", { cwd: main })).toThrow(/is not in a git checkout/);
    expect(() => remove(".", { cwd: tempDir() })).toThrow(/is not in a git checkout/);
  });

  it("refuses a locked worktree", () => {
    const { main } = createProject();
    git(main, "worktree", "add", "-q", "../feature");
    git(main, "worktree", "lock", "--reason", "on a USB drive", "../feature");
    expect(() => remove("../feature", { cwd: main, force: true })).toThrow(/is locked \(on a USB drive\): run git worktree unlock first/);
  });

  it("removes a worktree in a folder of the main checkout", () => {
    const { main, shared } = createProject();
    write(main, { ".gitignore": "node_modules/\n.env\nandroid/local.properties\n.worktrees/\n" });
    git(main, "commit", "-qam", "Ignore the worktrees");
    add(main, ".worktrees/feature", { cwd: main });
    link(path.join(main, ".worktrees", "feature"), { cwd: main });
    const before = shared();

    expect(remove(".worktrees/feature", { cwd: main }).ok).toBe(true);
    expect(fs.readdirSync(path.join(main, ".worktrees"))).toEqual([]);
    expect(shared()).toEqual(before);
  });
});
