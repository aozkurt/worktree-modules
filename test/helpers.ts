import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { removeTree } from "../src/links.js";

const made: string[] = [];

afterEach(() => {
  // removeTree never follows a link, so a failed test cannot reach outside its folder.
  for (const dir of made.splice(0)) removeTree(dir);
});

/** A new folder under the system temp folder, deleted after the test. Real path: CI runners use short names (RUNNER~1). */
export function tempDir(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wm-test-")));
  made.push(dir);
  return dir;
}

const identity = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

export function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

/** A junction on Windows, a symlink elsewhere: what npm makes for workspace packages. */
export function junction(target: string, at: string): void {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
}

export function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Where a link points, as a real path. */
export function target(p: string): string {
  return fs.realpathSync.native(path.resolve(path.dirname(p), fs.readlinkSync(p)));
}

/** The files under `dir`, relative, without following links. */
export function listFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (!entry.isSymbolicLink()) files.push(path.relative(dir, p).split(path.sep).join("/"));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return files.sort();
}

export interface Project {
  /** The temp folder that holds the main checkout and the worktrees. */
  root: string;
  /** The main checkout. */
  main: string;
  /** The files of the main checkout's node_modules folders and packages, to compare after a removal. */
  shared(): string[];
}

/**
 * A small app with npm workspaces, as npm leaves it after an install: node_modules with packages, a scope, a .bin
 * shim and links to the workspace packages (@acme/ui, @acme/core), and a node_modules of its own in packages/ui.
 */
export function createProject(): Project {
  const root = tempDir();
  const main = path.join(root, "app");
  write(main, {
    ".gitignore": "node_modules/\n.env\nandroid/local.properties\n",
    "package.json": `${JSON.stringify({ name: "app", private: true, workspaces: ["packages/*"], dependencies: { react: "^18.3.1" } }, null, 2)}\n`,
    "package-lock.json": `${JSON.stringify({ name: "app", lockfileVersion: 3, packages: { "node_modules/react": { version: "18.3.1" } } }, null, 2)}\n`,
    "packages/ui/package.json": '{ "name": "@acme/ui", "version": "1.0.0" }\n',
    "packages/ui/index.js": "export const from = 'main';\n",
    "packages/core/package.json": '{ "name": "@acme/core", "version": "1.0.0" }\n',
    "packages/core/index.js": "export const core = 1;\n",
    "android/build.gradle": "// app\n",
    "src/main.js": "import { from } from '@acme/ui';\n",
  });
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "core.autocrlf", "false");
  git(main, "add", "-A");
  git(main, "commit", "-qm", "First commit");

  write(main, {
    "node_modules/react/package.json": '{ "name": "react", "version": "18.3.1" }\n',
    "node_modules/react/index.js": "module.exports = 'react';\n",
    "node_modules/react/cjs/react.development.js": "// big\n",
    "node_modules/@types/node/index.d.ts": "export {};\n",
    "node_modules/@types/react/index.d.ts": "export {};\n",
    "node_modules/.package-lock.json": "{}\n",
    "node_modules/.bin/react.cmd": '@ECHO off\r\n"%~dp0\\..\\react\\index.js" %*\r\n',
    "packages/ui/node_modules/left-pad/index.js": "module.exports = 'left-pad';\n",
    ".env": "SECRET=1\n",
    "android/local.properties": "sdk.dir=/sdk\n",
  });
  junction(path.join(main, "packages", "ui"), path.join(main, "node_modules", "@acme", "ui"));
  junction(path.join(main, "packages", "core"), path.join(main, "node_modules", "@acme", "core"));
  const shared = () => [
    ...listFiles(path.join(main, "node_modules")).map((p) => `node_modules/${p}`),
    ...listFiles(path.join(main, "packages")).map((p) => `packages/${p}`),
  ];
  return { root, main, shared };
}

/** The project the README's examples come from: the small app with 310 more packages, Capacitor and a config. */
export function createDemoProject(): Project {
  const project = createProject();
  const { main } = project;
  write(main, {
    "capacitor.config.ts": "export default { appId: 'com.example.app' };\n",
    "worktree-modules.json": `${JSON.stringify({ copy: [".env", "android/local.properties"] }, null, 2)}\n`,
  });
  git(main, "add", "-A");
  git(main, "commit", "-qm", "Add Capacitor and the worktree-modules config");
  for (let i = 1; i <= 310; i++) write(main, { [`node_modules/package-${i}/index.js`]: `module.exports = ${i};\n` });
  return project;
}
