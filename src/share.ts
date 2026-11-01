import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { checkoutRoot, git, ignoredPaths, listWorktrees } from "./git.js";
import { copyTree, isLink, lexists, linkTarget, makeLink, removeLink } from "./links.js";
import { CommandError, type FolderResult, type InstallResult, type Note, type ShareResult, type UnlinkResult } from "./model.js";
import { linkFolder, moduleFolders, unlinkFolder } from "./modules.js";
import { isDirectory, realPath, samePath, show, slash, within } from "./paths.js";
import { detectTools, expand, findLockfile, installCommand, localFiles, lockfileDrift, matches } from "./project.js";

export interface LinkOptions {
  /** Share from this checkout instead of the main checkout. */
  from?: string;
  /** Run a clean install instead of linking node_modules. Overrides the config. */
  install?: boolean;
  /** Replace a real node_modules install with links. */
  force?: boolean;
  /** The config file. Default: worktree-modules.json or "worktreeModules" in package.json, in the worktree or else the source. */
  config?: string;
  /** Where install commands print: the terminal, or stderr when stdout must stay clean for --json. */
  installOutput?: "inherit" | "stderr";
  /** The folder the user is in, for the commands that messages suggest. Default: process.cwd(). */
  cwd?: string;
}

export interface AddOptions extends LinkOptions {
  /** What to check out, as for git worktree add. */
  commitish?: string;
  /** Create this branch (git worktree add -b). */
  branch?: string;
  detach?: boolean;
}

/** Creates a worktree with `git worktree add`, then links it. */
export function add(cwd: string, target: string, options: AddOptions = {}): ShareResult {
  const root = checkoutRoot(cwd);
  if (!root) throw new CommandError(`${cwd} is not in a git checkout`);
  const worktree = path.resolve(cwd, target);
  const args = ["worktree", "add"];
  if (options.branch) args.push("-b", options.branch);
  if (options.detach) args.push("--detach");
  args.push(worktree);
  if (options.commitish) args.push(options.commitish);
  const run = git(root, args);
  if (run.status !== 0) throw new CommandError(run.stderr.trim() || `git ${args.join(" ")} failed`);
  const created = /Preparing worktree \((.+)\)/.exec(run.stdout + run.stderr)?.[1];
  return { ...link(worktree, options), created };
}

/** Shares the source checkout's node_modules with a worktree, links the configured folders and copies the configured files. */
export function link(target: string, options: LinkOptions = {}): ShareResult {
  const { worktree, source } = checkouts(target, options.from);
  const { config } = loadConfig([worktree, source], options.config);
  const result: ShareResult = { ok: true, worktree, source, folders: [], copied: [], installs: [], notes: [] };
  const ignored = ignoredPaths(source);

  copyFiles(source, worktree, config.copy ?? [], result);

  const configured = config.link ?? [];
  for (const rel of configured.filter((rel) => path.posix.basename(rel) !== "node_modules")) linkExtra(source, worktree, rel, result);

  const folders = unique([...moduleFolders(source, ignored), ...configured.filter((rel) => path.posix.basename(rel) === "node_modules")]);
  const install = options.install ?? Boolean(config.install);
  if (install) {
    installAll(worktree, folders, typeof config.install === "string" ? config.install : undefined, options.installOutput ?? "inherit", result);
  } else {
    if (folders.length === 0 && fs.existsSync(path.join(worktree, "package.json"))) {
      result.notes.push({
        code: "nothing-to-share",
        severity: "warning",
        message: `The ${sourceName(source, options)} has no node_modules to share: install there first, or run ${suggest("link", worktree, options, "--install")} for a real install`,
      });
    }
    for (const rel of folders) {
      const linked = linkFolder(source, worktree, rel, options.force ?? false);
      if (!linked) continue;
      result.folders.push({ path: slash(rel), state: linked.state, links: linked.links, workspaces: linked.workspaces });
      if (linked.state === "kept") {
        result.notes.push({
          code: "kept-install",
          severity: "info",
          message: `${slash(rel)} is a real install here, so it stays as it is: ${suggest("link", worktree, options, "--force")} replaces it with links`,
        });
      }
      for (const name of linked.missing) {
        result.notes.push({
          code: "missing-workspace",
          severity: "warning",
          message: `${name} is a workspace package of the ${sourceName(source, options)} that this branch does not have, so it is left out`,
        });
      }
    }
    if (result.folders.some((folder) => folder.state === "linked")) result.notes.push(...linkNotes(source, worktree, folders, options));
  }

  const missing = localFiles(ignored).filter((rel) => !lexists(path.join(worktree, rel)) && !matches(rel, config.copy ?? []));
  if (missing.length > 0) {
    result.notes.push({
      code: "copy-hint",
      severity: "info",
      message: `Ignored files of the ${sourceName(source, options)} that this worktree lacks: ${missing.join(", ")}. List them under "copy" in worktree-modules.json to copy them.`,
    });
  }
  return result;
}

/** Takes the links out of a worktree's node_modules folders and configured folders, for a clean install of its own. */
export function unlink(target: string, options: Pick<LinkOptions, "from" | "config"> = {}): UnlinkResult {
  const { worktree, source } = checkouts(target, options.from);
  const { config } = loadConfig([worktree, source], options.config);
  const result: UnlinkResult = { ok: true, worktree, folders: [], unlinked: 0, notes: [] };
  const folders = unique([
    ...moduleFolders(source, ignoredPaths(source)),
    ...moduleFolders(worktree, ignoredPaths(worktree)),
    ...(config.link ?? []),
  ]);
  for (const rel of folders) {
    const dir = path.join(worktree, rel);
    const count = path.posix.basename(rel) === "node_modules" ? unlinkFolder(dir) : unlinkExtra(dir);
    if (count === undefined) {
      result.notes.push({ code: "kept-install", severity: "info", message: `${slash(rel)} is a real install, so it stays as it is` });
    } else if (count > 0) {
      result.folders.push(slash(rel));
      result.unlinked += count;
    }
  }
  return result;
}

function unlinkExtra(dir: string): number {
  if (!isLink(dir)) return 0;
  removeLink(dir);
  return 1;
}

/** The worktree that holds `target` and the checkout to share from. */
export function checkouts(target: string, from?: string): { worktree: string; source: string } {
  if (!isDirectory(target)) throw new CommandError(`${target} is not a folder`);
  const root = checkoutRoot(target);
  if (!root) throw new CommandError(`${target} is not in a git checkout`);
  const worktree = realPath(root);
  let source: string;
  if (from !== undefined) {
    const fromRoot = isDirectory(from) ? checkoutRoot(from) : undefined;
    if (!fromRoot) throw new CommandError(`--from ${from} is not a git checkout`);
    source = realPath(fromRoot);
  } else {
    const main = listWorktrees(worktree)[0];
    if (!main || main.bare) {
      throw new CommandError("The repository is bare, so there is no main checkout to share from: pass --from <checkout>");
    }
    source = realPath(main.path);
  }
  if (samePath(source, worktree)) {
    throw new CommandError(
      from === undefined
        ? `${worktree} is the main checkout, which the worktrees share from: run this in a worktree, or pass the worktree's path`
        : `--from is the worktree itself`,
    );
  }
  return { worktree, source };
}

function sourceName(source: string, options: LinkOptions): string {
  return options.from === undefined ? "main checkout" : `checkout ${source}`;
}

function copyFiles(source: string, worktree: string, patterns: string[], result: ShareResult): void {
  for (const pattern of patterns) {
    const found = expand(source, pattern);
    if (found.length === 0) {
      result.notes.push({ code: "copy-missing", severity: "warning", message: `Nothing to copy at ${pattern}: the source checkout does not have it` });
      continue;
    }
    for (const rel of found) {
      const to = path.join(worktree, rel);
      // Already there: tracked in this branch, or copied before and maybe changed since.
      if (lexists(to)) continue;
      copyTree(path.join(source, rel), to);
      result.copied.push(slash(rel));
    }
  }
}

// A configured folder that is not node_modules, such as ios/App/Pods, becomes one link.
function linkExtra(source: string, worktree: string, rel: string, result: ShareResult): void {
  const from = path.join(source, rel);
  const to = path.join(worktree, rel);
  if (!isDirectory(from)) {
    result.notes.push({ code: "link-missing", severity: "warning", message: `Nothing to link at ${rel}: the source checkout has no such folder` });
    return;
  }
  if (!isDirectory(path.dirname(to))) return;
  const folder: FolderResult = { path: slash(rel), state: "folder", links: 1, workspaces: [] };
  if (isLink(to)) {
    const current = linkTarget(to);
    if (current !== undefined && samePath(current, from)) {
      result.folders.push(folder);
      return;
    }
    removeLink(to);
  } else if (lexists(to)) {
    if (fs.readdirSync(to).length > 0) {
      result.folders.push({ ...folder, state: "kept", links: 0 });
      result.notes.push({ code: "kept-folder", severity: "info", message: `${slash(rel)} has files of its own here, so it stays as it is` });
      return;
    }
    fs.rmdirSync(to);
  }
  makeLink(from, to);
  result.folders.push(folder);
}

function installAll(worktree: string, folders: string[], configured: string | undefined, output: "inherit" | "stderr", result: ShareResult): void {
  // The projects: the folders that hold a node_modules, and the checkout itself. A folder with its own lockfile
  // (functions/) installs on its own; workspace packages install with the root.
  const projects = unique(["", ...folders.map((rel) => path.dirname(rel)).map((dir) => (dir === "." ? "" : dir))]).filter((dir) =>
    fs.existsSync(path.join(worktree, dir, "package.json")),
  );
  const withLockfile = projects.filter((dir) => findLockfile(path.join(worktree, dir)) !== undefined);
  const dirs = withLockfile.length > 0 ? withLockfile : projects.filter((dir) => !projects.some((other) => other !== dir && within(other, dir) !== undefined));
  for (const dir of dirs) {
    // A clean install deletes what is in node_modules first. Through a link, that would be the source's packages.
    for (const rel of folders) {
      if (within(dir, rel) !== undefined) unlinkFolder(path.join(worktree, rel));
    }
    const command = configured ?? installCommand(path.join(worktree, dir));
    const run = spawnSync(command, {
      cwd: path.join(worktree, dir),
      shell: true,
      stdio: output === "inherit" ? "inherit" : ["ignore", process.stderr, process.stderr],
    });
    const done: InstallResult = { dir: dir === "" ? "." : slash(dir), command, ok: run.status === 0 };
    result.installs.push(done);
    if (!done.ok) {
      result.ok = false;
      result.notes.push({
        code: "install-failed",
        severity: "error",
        message: `${command} failed in ${done.dir}${run.error ? `: ${run.error.message}` : run.status === null ? "" : ` with exit code ${run.status}`}`,
      });
      return;
    }
  }
}

function linkNotes(source: string, worktree: string, folders: string[], options: LinkOptions): Note[] {
  const notes: Note[] = [];
  const projects = unique(["", ...folders.map((rel) => path.dirname(rel)).map((dir) => (dir === "." ? "" : dir))]);
  for (const file of lockfileDrift(source, worktree, projects)) {
    notes.push({
      code: "lockfile-drift",
      severity: "warning",
      message: `${file} differs from the ${sourceName(source, options)}'s, so the linked packages may not match this branch: run ${suggest("link", worktree, options, "--install")} for a real install`,
    });
  }
  const tools = detectTools(projects.map((dir) => path.join(worktree, dir)));
  if (tools.capacitor) notes.push(capacitorNote(suggest("link", worktree, options, "--install")));
  if (tools.vite) notes.push(viteNote(source));
  return notes;
}

export function capacitorNote(command: string): Note {
  return {
    code: "capacitor",
    severity: "warning",
    message: `Capacitor: npx cap sync follows the links and writes the shared packages' paths into the native projects (android/capacitor.settings.gradle). Run ${command} before a native build.`,
  };
}

export function viteNote(source: string): Note {
  return {
    code: "vite",
    severity: "warning",
    message: `Vite: the dev server answers 403 for files it serves from the shared packages, such as fonts, unless server.fs.allow lists ${slash(path.join(source, "node_modules"))}. Builds are not affected.`,
  };
}

/** A command for the user to run, with the worktree's path unless they are in it. */
export function suggest(command: string, worktree: string, options: { cwd?: string }, flags = ""): string {
  const cwd = realPath(options.cwd ?? process.cwd());
  const here = within(worktree, cwd) !== undefined;
  return ["worktree-modules", command, here ? "" : show(worktree, cwd), flags].filter(Boolean).join(" ");
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

