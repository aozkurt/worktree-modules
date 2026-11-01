import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { main } from "../src/main.js";
import { createDemoProject, git, junction } from "./helpers.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

function shown(name: string): string[] {
  const start = readme.indexOf(`<!-- demo:${name}:start -->`);
  const end = readme.indexOf(`<!-- demo:${name}:end -->`);
  expect(start).toBeGreaterThan(-1);
  return readme
    .slice(start, end)
    .split("\n")
    .slice(1)
    .filter((line) => line.trim() !== "" && !line.startsWith("```"));
}

async function run(cwd: string, args: string[]): Promise<Set<string>> {
  let stdout = "";
  await main(args, {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: () => undefined },
    env: {},
    cwd,
    platform: "linux",
  });
  return new Set(stdout.split("\n"));
}

// The README shows real output of the demo project.
it("shows only lines that worktree-modules really prints", async () => {
  const { root, main: app } = createDemoProject();
  const added = await run(app, ["add", "../feature"]);
  git(app, "worktree", "add", "-q", "../hotfix");
  junction(path.join(app, "node_modules"), path.join(root, "hotfix", "node_modules"));
  const checked = await run(app, ["doctor"]);

  expect(shown("add").length).toBeGreaterThan(5);
  for (const line of shown("add")) expect(added, line).toContain(line);
  expect(shown("doctor").length).toBeGreaterThan(8);
  for (const line of shown("doctor")) expect(checked, line).toContain(line);
});
