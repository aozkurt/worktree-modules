import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { doctor } from "../src/doctor.js";
import { removeLink } from "../src/links.js";
import { add } from "../src/share.js";
import { createProject, git, junction, write } from "./helpers.js";

describe("doctor", () => {
  it("finds no problems in linked worktrees", () => {
    const { root, main } = createProject();
    add(main, "../feature", { cwd: main, config: writeConfig(root, { copy: [".env", "android/local.properties"] }) });

    const result = doctor(main, { cwd: main, config: writeConfig(root, { copy: [".env", "android/local.properties"] }) });

    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({ errors: 0, warnings: 0, infos: 0 });
    expect(result.worktrees.map(({ path: where, branch, source, folders }) => ({ where, branch, source, folders }))).toEqual([
      {
        where: main,
        branch: "main",
        source: true,
        folders: [
          { path: "node_modules", kind: "installed", links: 2 },
          { path: "packages/ui/node_modules", kind: "installed", links: 0 },
        ],
      },
      {
        where: path.join(root, "feature"),
        branch: "feature",
        source: false,
        folders: [
          { path: "node_modules", kind: "links", links: 4 },
          { path: "packages/ui/node_modules", kind: "links", links: 1 },
        ],
      },
    ]);
  });

  it("finds single links, broken links, outdated links and workspace packages of the main checkout", () => {
    const { root, main } = createProject();
    // A whole-folder link, as a manual junction or another tool makes it.
    git(main, "worktree", "add", "-q", "../single");
    junction(path.join(main, "node_modules"), path.join(root, "single", "node_modules"));
    // Linked, then the main checkout loses one package and gains another.
    write(main, { "node_modules/old/index.js": "old\n" });
    add(main, "../stale", { cwd: main });
    fs.rmSync(path.join(main, "node_modules", "old"), { recursive: true });
    write(main, { "node_modules/zod/index.js": "zod\n" });
    // Linked, then @acme/ui pointed at the main checkout's package.
    add(main, "../wrong", { cwd: main });
    removeLink(path.join(root, "wrong", "node_modules", "@acme", "ui"));
    junction(path.join(main, "packages", "ui"), path.join(root, "wrong", "node_modules", "@acme", "ui"));

    const result = doctor(main, { cwd: main });
    const notes = Object.fromEntries(result.worktrees.map((worktree) => [path.basename(worktree.path), worktree.notes]));

    expect(result.ok).toBe(false);
    expect(notes.single).toContainEqual({
      code: "single-link",
      severity: "error",
      message: expect.stringMatching(
        /^node_modules is one link to the main checkout's node_modules: npm ci here would empty it, git worktree remove from Git for Windows before 2.54 would delete its files, and the workspace packages @acme\/core, @acme\/ui come from the main checkout\. worktree-modules link \.\.\/single replaces it with a link per package\.$/,
      ),
    });
    expect(notes.single).toContainEqual(expect.objectContaining({ code: "not-linked", message: expect.stringContaining("packages/ui/node_modules is missing") }));
    expect(notes.stale).toContainEqual({
      code: "broken-links",
      severity: "error",
      message: "node_modules has 1 link to folders that are gone (old): worktree-modules link ../stale redoes them",
    });
    expect(notes.stale).toContainEqual({
      code: "outdated-links",
      severity: "warning",
      message: "1 package of the main checkout is not linked in node_modules (zod): worktree-modules link ../stale adds them",
    });
    expect(notes.wrong).toContainEqual({
      code: "main-workspace",
      severity: "error",
      message: "@acme/ui in node_modules is the main checkout's, not this worktree's: worktree-modules link ../wrong links this worktree's own",
    });
    expect(result.summary.errors).toBe(3);
  });

  it("reports lockfile drift, files to copy and a folder that is gone", () => {
    const { root, main } = createProject();
    add(main, "../feature", { cwd: main });
    write(path.join(root, "feature"), { "package-lock.json": "{}\n" });
    git(main, "worktree", "add", "-q", "../gone");
    fs.rmSync(path.join(root, "gone"), { recursive: true });

    const result = doctor(main, { cwd: main, config: writeConfig(root, { copy: [".env"] }) });
    const [, feature, gone] = result.worktrees;

    expect(feature!.notes.map((note) => note.code)).toEqual(["lockfile-drift", "not-copied", "copy-hint"]);
    expect(feature!.notes[1]!.message).toBe(".env is not here: worktree-modules link ../feature copies it");
    expect(feature!.notes[2]!.message).toContain("lacks: android/local.properties.");
    expect(gone!.notes).toEqual([{ code: "gone", severity: "warning", message: "The folder is gone: git worktree prune forgets it" }]);
    expect(result.ok).toBe(true);
  });

  it("names Capacitor and Vite once for the project", () => {
    const { main } = createProject();
    write(main, { "capacitor.config.ts": "export default {};\n", "vite.config.ts": "export default {};\n" });
    git(main, "add", "-A");
    git(main, "commit", "-qm", "Use Capacitor and Vite");
    add(main, "../one", { cwd: main });
    add(main, "../two", { cwd: main });

    const result = doctor(main, { cwd: main });

    expect(result.notes.map((note) => note.code)).toEqual(["capacitor", "vite"]);
    expect(result.worktrees.flatMap((worktree) => worktree.notes).map((note) => note.code)).toEqual(["copy-hint", "copy-hint"]);
  });
});

function writeConfig(root: string, config: object): string {
  const file = path.join(root, `config-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}
