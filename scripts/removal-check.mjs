#!/usr/bin/env node
// Which ways of deleting a folder follow a link (a junction on Windows, a symlink elsewhere) and delete the
// files it points to? Each check gets a fresh temp folder: shared/ with 4 files, a link to it, one command.
// Then it counts the files left in shared/. Usage: node scripts/removal-check.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const windows = process.platform === "win32";
const type = windows ? "junction" : "dir";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "removal-check-")));
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function run(command, args, cwd = base, options = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 180_000, ...options });
  return result.error ? undefined : result.status;
}
const has = (command, ...args) => run(command, args) === 0;
// npm is npm.cmd on Windows, which needs a shell.
const shell = (line, cwd = base) => {
  const result = spawnSync(line, { cwd, env, encoding: "utf8", timeout: 180_000, shell: true });
  return result.error ? undefined : result.status;
};
const posix = (p) => p.replaceAll("\\", "/");

function fill(dir) {
  for (const [rel, text] of [["marker.txt", "1"], [".hidden", "1"], ["pkg/index.js", "1"], ["pkg/deep/file.txt", "1"]]) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

function count(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? count(path.join(dir, entry.name)) : 1;
  }
  return n;
}

let id = 0;
// parent/own.txt and parent/link -> shared
function plain(action) {
  const dir = path.join(base, String(++id));
  const shared = path.join(dir, "shared");
  const parent = path.join(dir, "parent");
  fill(shared);
  fs.mkdirSync(parent);
  fs.writeFileSync(path.join(parent, "own.txt"), "1");
  fs.symlinkSync(shared, path.join(parent, "link"), type);
  const status = action({ parent, link: path.join(parent, "link") });
  return { status, lost: 4 - count(shared) };
}

// A repository whose ignored node_modules is the shared folder, and a worktree that links to it.
function worktree(linkWhole, action) {
  const dir = path.join(base, String(++id));
  const main = path.join(dir, "main");
  const wt = path.join(dir, "wt");
  fs.mkdirSync(main, { recursive: true });
  run("git", ["init", "-q"], main);
  fs.writeFileSync(path.join(main, ".gitignore"), "node_modules/\n");
  run("git", ["add", "."], main);
  run("git", ["commit", "-qm", "init"], main);
  run("git", ["worktree", "add", "-q", "--detach", wt], main);
  const shared = path.join(main, "node_modules");
  fill(shared);
  if (linkWhole) fs.symlinkSync(shared, path.join(wt, "node_modules"), type);
  else {
    fs.mkdirSync(path.join(wt, "node_modules"));
    fs.symlinkSync(path.join(shared, "pkg"), path.join(wt, "node_modules", "pkg"), type);
  }
  const status = action({ main, wt });
  return { status, lost: 4 - count(shared) };
}

// An npm project whose only dependency is a local tarball, so npm needs no network.
function npmWorktree(linkWhole, command) {
  const dir = path.join(base, String(++id));
  const pkg = path.join(dir, "dep");
  const main = path.join(dir, "main");
  fs.mkdirSync(pkg, { recursive: true });
  fs.mkdirSync(main);
  fs.writeFileSync(path.join(pkg, "package.json"), '{ "name": "dep", "version": "1.0.0" }');
  shell(`npm pack --silent --pack-destination "${main}"`, pkg);
  fs.writeFileSync(path.join(main, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(main, "package.json"), '{ "name": "app", "private": true, "dependencies": { "dep": "file:dep-1.0.0.tgz" } }');
  shell("npm install --offline --no-audit --no-fund --silent", main);
  run("git", ["init", "-q"], main);
  run("git", ["add", "."], main);
  run("git", ["commit", "-qm", "init"], main);
  const wt = path.join(dir, "wt");
  run("git", ["worktree", "add", "-q", "--detach", wt], main);
  const shared = path.join(main, "node_modules");
  fill(path.join(shared, "other"));
  if (linkWhole) fs.symlinkSync(shared, path.join(wt, "node_modules"), type);
  else {
    fs.mkdirSync(path.join(wt, "node_modules"));
    for (const name of fs.readdirSync(shared)) {
      if (fs.statSync(path.join(shared, name)).isDirectory()) fs.symlinkSync(path.join(shared, name), path.join(wt, "node_modules", name), type);
    }
  }
  const status = shell(`${command} --offline --no-audit --no-fund --silent`, wt);
  return { status, lost: 4 - count(path.join(shared, "other")) };
}

const powershell = (exe) => (script) => run(exe, ["-NoProfile", "-NonInteractive", "-Command", script]);
const cmd = (line) => run("cmd.exe", ["/d", "/s", "/c", `"${line}"`], base, { windowsVerbatimArguments: true });
const node = (code) => run(process.execPath, ["-e", code]);
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check("git worktree remove", () => worktree(true, ({ main, wt }) => run("git", ["worktree", "remove", wt], main)));
check("git worktree remove --force", () => worktree(true, ({ main, wt }) => run("git", ["worktree", "remove", "--force", wt], main)));
check("git worktree remove --force, per-package links", () => worktree(false, ({ main, wt }) => run("git", ["worktree", "remove", "--force", wt], main)));
check("git clean -fdx in the worktree", () => worktree(true, ({ wt }) => run("git", ["clean", "-fdx"], wt)));
if (has("bash", "-c", "true")) {
  check("rm -rf <link>", () => plain(({ link }) => run("bash", ["-c", `rm -rf '${posix(link)}'`])));
  check("rm -rf <link>/ (trailing slash)", () => plain(({ link }) => run("bash", ["-c", `rm -rf '${posix(link)}/'`])));
  check("rm -rf <folder that holds the link>", () => plain(({ parent }) => run("bash", ["-c", `rm -rf '${posix(parent)}'`])));
}
for (const [exe, name] of [["powershell.exe", "PowerShell 5.1"], ["pwsh", "PowerShell 7"]]) {
  if (!has(exe, "-NoProfile", "-Command", "exit 0")) continue;
  check(`${name}: Remove-Item -Recurse -Force <link>`, () => plain(({ link }) => powershell(exe)(`Remove-Item -LiteralPath '${link}' -Recurse -Force`)));
  check(`${name}: Remove-Item -Recurse -Force <folder>`, () => plain(({ parent }) => powershell(exe)(`Remove-Item -LiteralPath '${parent}' -Recurse -Force`)));
}
if (windows) {
  check("cmd: rmdir /s /q <link>", () => plain(({ link }) => cmd(`rmdir /s /q "${link}"`)));
  check("cmd: rmdir /s /q <folder>", () => plain(({ parent }) => cmd(`rmdir /s /q "${parent}"`)));
  check("cmd: del /s /q <folder>", () => plain(({ parent }) => cmd(`del /s /q "${parent}"`)));
}
check("Node: fs.rmSync(<link>, { recursive: true })", () => plain(({ link }) => node(`require("fs").rmSync(${JSON.stringify(link)}, { recursive: true, force: true })`)));
check("Node: fs.rmSync(<folder>, { recursive: true })", () => plain(({ parent }) => node(`require("fs").rmSync(${JSON.stringify(parent)}, { recursive: true, force: true })`)));
if (shell("npm --version") === 0) {
  check("npm ci, node_modules is one link", () => npmWorktree(true, "npm ci"));
  check("npm install, node_modules is one link", () => npmWorktree(true, "npm install"));
  check("npm ci, per-package links", () => npmWorktree(false, "npm ci"));
}

const version = (command) => (spawnSync(`${command} --version`, { encoding: "utf8", shell: true }).stdout ?? "").trim().split("\n")[0];
console.log(`${os.type()} ${os.release()}, ${version("git")}, Node ${process.version}, npm ${version("npm")}\n`);
console.log("| Command | Deleted the files the link points to |");
console.log("| --- | --- |");
for (const [name, fn] of checks) {
  let cell;
  try {
    const { status, lost } = fn();
    cell = lost > 0 ? `**Yes**, ${lost} of 4` : "No";
    if (status !== 0) cell += ` (exit code ${status})`;
  } catch (error) {
    cell = `could not run: ${error.message}`;
  }
  console.log(`| ${name} | ${cell} |`);
}
fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
