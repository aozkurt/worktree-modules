import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import { createProject, git, junction, tempDir } from "./helpers.js";

async function run(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    stdout: { write: (text: string) => (stdout += text), isTTY: false },
    stderr: { write: (text: string) => (stderr += text) },
    env,
    cwd,
    platform: "linux",
  });
  return { code, stdout, stderr };
}

describe("worktree-modules", () => {
  it("adds a worktree and prints what it linked", async () => {
    const { main } = createProject();
    const { code, stdout } = await run(main, ["add", "../feature"]);
    expect(code).toBe(0);
    expect(stdout.split("\n")).toEqual([
      "✔ Created ../feature  (new branch 'feature')",
      "✔ Linked node_modules  2 packages from the main checkout, 2 from this worktree: @acme/core, @acme/ui",
      "✔ Linked packages/ui/node_modules  1 package from the main checkout",
      '● Ignored files of the main checkout that this worktree lacks: .env, android/local.properties. List them under "copy" in worktree-modules.json to copy them.',
      "",
      "Remove it with: npx worktree-modules remove ../feature",
      "",
    ]);
  });

  it("prints JSON for scripts", async () => {
    const { root, main } = createProject();
    const added = JSON.parse((await run(main, ["add", "../feature", "--json"])).stdout);
    expect(added).toMatchObject({ ok: true, worktree: path.join(root, "feature"), created: "new branch 'feature'" });

    const doctor = await run(main, ["doctor", "--json"]);
    expect(doctor.code).toBe(0);
    expect(JSON.parse(doctor.stdout).summary).toEqual({ errors: 0, warnings: 0, infos: 1 });

    const removed = await run(main, ["remove", "../feature", "--json"]);
    expect(JSON.parse(removed.stdout)).toMatchObject({ ok: true, unlinked: 5, method: "git" });
  });

  it("exits with 1 when doctor finds errors", async () => {
    const { root, main } = createProject();
    git(main, "worktree", "add", "-q", "../feature");
    junction(path.join(main, "node_modules"), path.join(root, "feature", "node_modules"));
    const { code, stdout } = await run(main, ["doctor"]);
    expect(code).toBe(1);
    expect(stdout).toContain("✖ ../feature  feature  node_modules a single link, packages/ui/node_modules missing");
    expect(stdout).toContain("✖ 1 error  ▲ 1 warning  ● 1 note  (2 worktrees)");
  });

  it("exits with 1 and says why when a command fails", async () => {
    const { main } = createProject();
    const human = await run(main, ["link"]);
    expect(human.code).toBe(1);
    expect(human.stderr).toMatch(/^✖ .* is the main checkout, which the worktrees share from/);
    const json = await run(main, ["link", "--json"]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({ ok: false, error: expect.stringContaining("is the main checkout") });
  });

  it("colors the output only when asked or in a terminal", async () => {
    const { main } = createProject();
    git(main, "worktree", "add", "-q", "../feature");
    expect((await run(main, ["link", "../feature"])).stdout).not.toContain("\u001b[");
    expect((await run(main, ["link", "../feature"], { FORCE_COLOR: "1" })).stdout).toContain("\u001b[32m");
  });

  it("rejects bad usage with exit code 2", async () => {
    const { main } = createProject();
    expect(await run(main, ["--bogus"])).toMatchObject({ code: 2, stderr: expect.stringContaining("Unknown option '--bogus'") });
    expect(await run(main, ["move", "a"])).toMatchObject({ code: 2, stderr: expect.stringContaining('unknown command "move"') });
    expect(await run(main, ["remove"])).toMatchObject({ code: 2, stderr: expect.stringContaining("usage: worktree-modules remove <path>") });
    expect(await run(main, ["link", "a", "b"])).toMatchObject({ code: 2, stderr: expect.stringContaining("usage: worktree-modules link [<path>]") });
    expect(await run(main, ["link", "--branch", "x"])).toMatchObject({ code: 2, stderr: expect.stringContaining("--branch works with add, not link") });
    expect(await run(main, ["remove", "x", "--install"])).toMatchObject({ code: 2, stderr: expect.stringContaining("--install works with add, link, not remove") });
    expect(await run(main, ["add", "x", "-b", "y", "--detach"])).toMatchObject({ code: 2, stderr: expect.stringContaining("--branch and --detach") });
  });

  it("shows help and the version", async () => {
    const { main } = createProject();
    expect((await run(main, ["--help"])).stdout).toContain("Usage\n  npx worktree-modules add <path> [<commit-ish>]");
    expect(await run(main, [])).toMatchObject({ code: 2, stdout: expect.stringContaining("Usage") });
    expect((await run(main, ["-v"])).stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});

describe("paths in the output", () => {
  it("are relative when near, and absolute when far", async () => {
    const { main } = createProject();
    const far = path.join(tempDir(), "feature");
    // From app/src, the worktree is three folders up and over.
    const { stdout } = await run(path.join(main, "src"), ["add", far]);
    expect(stdout).toContain(`✔ Created ${far.split(path.sep).join("/")}  (new branch 'feature')`);
    expect((await run(main, ["add", "../near"])).stdout).toContain("✔ Created ../near  (new branch 'near')");
  });
});
