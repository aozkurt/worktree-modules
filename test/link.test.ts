import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CommandError } from "../src/model.js";
import { MARKER } from "../src/modules.js";
import { add, link, unlink } from "../src/share.js";
import { createProject, git, isLink, junction, listFiles, target, write } from "./helpers.js";

describe("add", () => {
  it("creates the worktree and links each package of the main checkout", () => {
    const { root, main } = createProject();
    const result = add(main, "../feature", { cwd: main });
    const feature = path.join(root, "feature");

    expect(result.ok).toBe(true);
    expect(result.created).toBe("new branch 'feature'");
    expect(git(feature, "branch", "--show-current").trim()).toBe("feature");
    expect(result.folders).toEqual([
      { path: "node_modules", state: "linked", links: 2, workspaces: ["@acme/core", "@acme/ui"] },
      { path: "packages/ui/node_modules", state: "linked", links: 1, workspaces: [] },
    ]);

    const modules = path.join(feature, "node_modules");
    expect(isLink(modules)).toBe(false);
    expect(target(path.join(modules, "react"))).toBe(path.join(main, "node_modules", "react"));
    // A scope without workspace packages is one link.
    expect(target(path.join(modules, "@types"))).toBe(path.join(main, "node_modules", "@types"));
    expect(target(path.join(feature, "packages", "ui", "node_modules", "left-pad"))).toBe(
      path.join(main, "packages", "ui", "node_modules", "left-pad"),
    );
    // A real .bin with copies of the shims; package manager files stay with the main checkout.
    expect(isLink(path.join(modules, ".bin"))).toBe(false);
    expect(fs.readdirSync(path.join(modules, ".bin"))).toEqual(["react.cmd"]);
    expect(fs.existsSync(path.join(modules, ".package-lock.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(modules, MARKER), "utf8")).source).toBe(path.join(main, "node_modules"));
  });

  it("links workspace packages to the worktree's own folders", () => {
    const { root, main } = createProject();
    add(main, "../feature", { cwd: main });
    const feature = path.join(root, "feature");
    write(feature, { "packages/ui/index.js": "export const from = 'feature';\n" });

    expect(target(path.join(feature, "node_modules", "@acme", "ui"))).toBe(path.join(feature, "packages", "ui"));
    expect(fs.readFileSync(path.join(feature, "node_modules", "@acme", "ui", "index.js"), "utf8")).toContain("'feature'");
    expect(fs.readFileSync(path.join(main, "node_modules", "@acme", "ui", "index.js"), "utf8")).toContain("'main'");
  });

  it("passes the branch options to git worktree add", () => {
    const { root, main } = createProject();
    git(main, "branch", "existing");
    expect(add(main, "../one", { cwd: main, branch: "topic" }).created).toBe("new branch 'topic'");
    expect(add(main, "../two", { cwd: main, commitish: "existing" }).created).toBe("checking out 'existing'");
    expect(add(main, "../three", { cwd: main, detach: true }).created).toMatch(/^detached HEAD [0-9a-f]+$/);
    expect(git(path.join(root, "one"), "branch", "--show-current").trim()).toBe("topic");
  });

  it("stops when git worktree add fails", () => {
    const { main } = createProject();
    expect(() => add(main, "../feature", { cwd: main, commitish: "no-such-branch" })).toThrow(/invalid reference: no-such-branch/);
  });
});

describe("link", () => {
  it("links an existing worktree and can run again", () => {
    const { root, main } = createProject();
    git(main, "worktree", "add", "-q", "../feature");
    const feature = path.join(root, "feature");
    const first = link(feature, { cwd: main });
    write(main, { "node_modules/zod/index.js": "module.exports = 'zod';\n" });
    const second = link(feature, { cwd: main });

    expect(first.folders[0]).toMatchObject({ path: "node_modules", links: 2 });
    expect(second.folders[0]).toMatchObject({ path: "node_modules", links: 3 });
    expect(target(path.join(feature, "node_modules", "zod"))).toBe(path.join(main, "node_modules", "zod"));
  });

  it("works from a subfolder of the worktree", () => {
    const { root, main } = createProject();
    git(main, "worktree", "add", "-q", "../feature");
    const result = link(path.join(root, "feature", "src"), { cwd: path.join(root, "feature", "src") });
    expect(result.worktree).toBe(path.join(root, "feature"));
    expect(result.folders).toHaveLength(2);
  });

  it("replaces a single link to the main checkout's node_modules", () => {
    const { root, main, shared } = createProject();
    git(main, "worktree", "add", "-q", "../feature");
    const feature = path.join(root, "feature");
    junction(path.join(main, "node_modules"), path.join(feature, "node_modules"));
    const before = shared();

    link(feature, { cwd: main });

    expect(isLink(path.join(feature, "node_modules"))).toBe(false);
    expect(target(path.join(feature, "node_modules", "@acme", "ui"))).toBe(path.join(feature, "packages", "ui"));
    expect(shared()).toEqual(before);
  });

  it("keeps a real install unless --force", () => {
    const { root, main, shared } = createProject();
    git(main, "worktree", "add", "-q", "../feature");
    const feature = path.join(root, "feature");
    write(feature, { "node_modules/react/index.js": "module.exports = 'own install';\n" });
    junction(path.join(feature, "packages", "ui"), path.join(feature, "node_modules", "@acme", "ui"));
    const before = shared();

    const kept = link(feature, { cwd: main });
    expect(kept.folders[0]).toMatchObject({ path: "node_modules", state: "kept" });
    expect(kept.notes.map((note) => note.code)).toContain("kept-install");
    expect(fs.readFileSync(path.join(feature, "node_modules", "react", "index.js"), "utf8")).toContain("own install");

    const replaced = link(feature, { cwd: main, force: true });
    expect(replaced.folders[0]).toMatchObject({ path: "node_modules", state: "linked" });
    expect(target(path.join(feature, "node_modules", "react"))).toBe(path.join(main, "node_modules", "react"));
    // Replacing the worktree's own packages deleted their files and nothing else: its packages/ui is still there.
    expect(fs.existsSync(path.join(feature, "packages", "ui", "index.js"))).toBe(true);
    expect(shared()).toEqual(before);
  });

  it("leaves out workspace packages that the branch does not have", () => {
    const { root, main } = createProject();
    git(main, "worktree", "add", "-q", "../feature");
    write(main, { "packages/extra/package.json": '{ "name": "@acme/extra" }\n' });
    junction(path.join(main, "packages", "extra"), path.join(main, "node_modules", "@acme", "extra"));

    const result = link(path.join(root, "feature"), { cwd: main });

    expect(fs.existsSync(path.join(root, "feature", "node_modules", "@acme", "extra"))).toBe(false);
    expect(result.notes).toContainEqual(expect.objectContaining({ code: "missing-workspace", message: expect.stringContaining("@acme/extra") }));
  });

  it("refuses the main checkout", () => {
    const { main } = createProject();
    expect(() => link(main, { cwd: main })).toThrow(CommandError);
    expect(() => link(main, { cwd: main })).toThrow(/is the main checkout/);
  });

  it("shares from another checkout with --from", () => {
    const { root, main } = createProject();
    git(main, "worktree", "add", "-q", "../one");
    git(main, "worktree", "add", "-q", "../two");
    link(path.join(root, "one"), { cwd: main });
    const result = link(path.join(root, "two"), { cwd: main, from: path.join(root, "one") });
    expect(result.source).toBe(path.join(root, "one"));
    expect(target(path.join(root, "two", "node_modules", "react"))).toBe(path.join(main, "node_modules", "react"));
    expect(target(path.join(root, "two", "node_modules", "@acme", "ui"))).toBe(path.join(root, "two", "packages", "ui"));
  });
});

describe("files and folders from the config", () => {
  it("copies the files it lists and hints at the others", () => {
    const { root, main } = createProject();
    write(main, { "worktree-modules.json": JSON.stringify({ copy: ["android/*.properties", ".env.missing"] }) });
    git(main, "add", "worktree-modules.json");
    git(main, "commit", "-qm", "Add the config");

    const result = add(main, "../feature", { cwd: main });

    expect(result.copied).toEqual(["android/local.properties"]);
    expect(fs.readFileSync(path.join(root, "feature", "android", "local.properties"), "utf8")).toBe("sdk.dir=/sdk\n");
    expect(result.notes).toContainEqual(expect.objectContaining({ code: "copy-missing", message: expect.stringContaining(".env.missing") }));
    expect(result.notes).toContainEqual(expect.objectContaining({ code: "copy-hint", message: expect.stringContaining("lacks: .env.") }));
  });

  it("does not overwrite a file the worktree already has", () => {
    const { root, main } = createProject();
    git(main, "worktree", "add", "-q", "../feature");
    write(path.join(root, "feature"), { ".env": "SECRET=changed\n" });
    const result = link(path.join(root, "feature"), { cwd: main, config: writeConfig(root, { copy: [".env"] }) });
    expect(result.copied).toEqual([]);
    expect(fs.readFileSync(path.join(root, "feature", ".env"), "utf8")).toBe("SECRET=changed\n");
  });

  it("links the folders it lists as one link", () => {
    const { root, main } = createProject();
    write(main, { ".gitignore": "node_modules/\n.env\nandroid/local.properties\nios/App/Pods/\n", "ios/App/Podfile": "platform :ios\n" });
    git(main, "add", "-A");
    git(main, "commit", "-qm", "Add the iOS app");
    write(main, { "ios/App/Pods/Manifest.lock": "pods\n" });
    git(main, "worktree", "add", "-q", "../feature");

    const result = link(path.join(root, "feature"), { cwd: main, config: writeConfig(root, { link: ["ios/App/Pods"] }) });

    expect(result.folders).toContainEqual({ path: "ios/App/Pods", state: "folder", links: 1, workspaces: [] });
    expect(target(path.join(root, "feature", "ios", "App", "Pods"))).toBe(path.join(main, "ios", "App", "Pods"));
  });
});

describe("warnings", () => {
  it("warns when the lockfile differs from the main checkout's", () => {
    const { main } = createProject();
    git(main, "switch", "-q", "-c", "upgrade");
    write(main, { "package-lock.json": '{ "lockfileVersion": 3, "packages": {} }\n' });
    git(main, "commit", "-qam", "Upgrade");
    git(main, "switch", "-q", "main");

    const result = add(main, "../upgrade", { cwd: main, commitish: "upgrade" });

    expect(result.notes).toContainEqual(
      expect.objectContaining({ code: "lockfile-drift", message: expect.stringContaining("worktree-modules link ../upgrade --install") }),
    );
  });

  it("does not count line endings as lockfile drift", () => {
    const { root, main } = createProject();
    git(main, "config", "core.autocrlf", "true");
    git(main, "worktree", "add", "-q", "../feature");
    fs.writeFileSync(path.join(root, "feature", "package-lock.json"), fs.readFileSync(path.join(main, "package-lock.json"), "utf8").replaceAll("\n", "\r\n"));
    const result = link(path.join(root, "feature"), { cwd: main });
    expect(result.notes.map((note) => note.code)).not.toContain("lockfile-drift");
  });

  it("warns about Capacitor and Vite, which see through the links", () => {
    const { root, main } = createProject();
    write(main, {
      "capacitor.config.ts": "export default {};\n",
      "package.json": JSON.stringify({ name: "app", private: true, workspaces: ["packages/*"], devDependencies: { vite: "^7.0.0" } }),
    });
    git(main, "add", "-A");
    git(main, "commit", "-qm", "Use Capacitor and Vite");

    const codes = add(main, "../feature", { cwd: main }).notes.map((note) => note.code);
    expect(codes).toContain("capacitor");
    expect(codes).toContain("vite");
    expect(link(path.join(root, "feature"), { cwd: main, install: true, config: writeConfig(root, { install: "node -e 0" }) }).notes.map((note) => note.code)).not.toContain("capacitor");
  });

  it("says so when the main checkout has nothing to share", () => {
    const { root, main } = createProject();
    git(main, "worktree", "add", "-q", "../feature");
    fs.renameSync(path.join(main, "node_modules"), path.join(root, "moved"));
    fs.renameSync(path.join(main, "packages", "ui", "node_modules"), path.join(root, "moved-ui"));
    const result = link(path.join(root, "feature"), { cwd: main });
    expect(result.folders).toEqual([]);
    expect(result.notes.map((note) => note.code)).toContain("nothing-to-share");
  });
});

describe("--install", () => {
  it("takes the links out, then runs the install command", () => {
    const { root, main, shared } = createProject();
    add(main, "../feature", { cwd: main });
    const feature = path.join(root, "feature");
    const before = shared();
    // The command records whether node_modules was still there when it ran.
    const command = `node -e "require('fs').writeFileSync('ran.txt', String(require('fs').existsSync('node_modules')))"`;

    const result = link(feature, { cwd: main, install: true, config: writeConfig(root, { install: command }), installOutput: "stderr" });

    expect(result.ok).toBe(true);
    expect(result.installs).toEqual([{ dir: ".", command, ok: true }]);
    expect(fs.readFileSync(path.join(feature, "ran.txt"), "utf8")).toBe("false");
    expect(fs.existsSync(path.join(feature, "packages", "ui", "node_modules"))).toBe(false);
    expect(shared()).toEqual(before);
  });

  it("reports a failed install", () => {
    const { root, main } = createProject();
    git(main, "worktree", "add", "-q", "../feature");
    const result = link(path.join(root, "feature"), { cwd: main, install: true, config: writeConfig(root, { install: 'node -e "process.exit(3)"' }), installOutput: "stderr" });
    expect(result.ok).toBe(false);
    expect(result.notes).toContainEqual(expect.objectContaining({ code: "install-failed", message: expect.stringContaining("exit code 3") }));
  });
});

describe("unlink", () => {
  it("takes the links out and leaves the main checkout's files", () => {
    const { root, main, shared } = createProject();
    add(main, "../feature", { cwd: main });
    const before = shared();
    const result = unlink(path.join(root, "feature"), { from: undefined });
    expect(result.unlinked).toBe(5);
    expect(result.folders).toEqual(["node_modules", "packages/ui/node_modules"]);
    expect(fs.existsSync(path.join(root, "feature", "node_modules"))).toBe(false);
    expect(listFiles(path.join(root, "feature", "packages"))).toEqual(["core/index.js", "core/package.json", "ui/index.js", "ui/package.json"]);
    expect(shared()).toEqual(before);
  });
});

function writeConfig(root: string, config: object): string {
  const file = path.join(root, `config-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

describe("folders with only caches", () => {
  it("are left out", () => {
    const { root, main } = createProject();
    write(main, { "packages/core/node_modules/.vite/vitest/results.json": "{}\n" });
    const result = add(main, "../feature", { cwd: main });
    expect(result.folders.map((folder) => folder.path)).toEqual(["node_modules", "packages/ui/node_modules"]);
    expect(fs.existsSync(path.join(root, "feature", "packages", "core", "node_modules"))).toBe(false);
  });
});
