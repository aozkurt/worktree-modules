import fs from "node:fs";
import path from "node:path";
import { changes, checkoutRoot, git, listWorktrees } from "./git.js";
import { findLinks, hasCode, isLink, lexists, linkTarget, removeLink, removeTree } from "./links.js";
import { CommandError, type RemoveResult } from "./model.js";
import { isDirectory, realPath, samePath, show, within } from "./paths.js";

export interface RemoveOptions {
  /** Remove the worktree even when it has changes, like git worktree remove --force. */
  force?: boolean;
  /** The folder the user is in: relative paths start there, and messages show paths from there. Default: process.cwd(). */
  cwd?: string;
}

/**
 * Removes a worktree without touching what its links point to. It takes out every link first, then deletes the
 * worktree's own files (paths over 260 characters too), and lets git worktree remove forget it. Git would follow
 * junctions on Windows, and when it fails to delete a folder it forgets the worktree anyway.
 */
export function remove(target: string, options: RemoveOptions = {}): RemoveResult {
  const cwd = options.cwd ?? process.cwd();
  const wanted = path.resolve(cwd, target);
  // The folder may be gone already; then the repository is the one we are in.
  const repo = isDirectory(wanted) ? wanted : cwd;
  if (!isDirectory(repo) || !checkoutRoot(repo)) throw new CommandError(`${target} is not in a git checkout`);
  const worktrees = listWorktrees(repo);
  const worktree = worktrees.find((item) => samePath(realPath(item.path), realPath(wanted)));
  if (!worktree) throw new CommandError(`${target} is not a worktree of this repository (git worktree list shows them)`);
  if (worktree.main) throw new CommandError(`${target} is the main checkout, which is not removed this way`);
  const gitDir = worktrees[0]!.path;
  const result: RemoveResult = { ok: true, worktree: worktree.path, unlinked: 0, method: "git", notes: [] };

  if (!lexists(worktree.path)) {
    git(gitDir, ["worktree", "prune"]);
    result.method = "prune";
    return result;
  }
  if (worktree.locked !== undefined) {
    throw new CommandError(`${target} is locked${worktree.locked ? ` (${worktree.locked})` : ""}: run git worktree unlock first`);
  }
  if (!options.force) {
    // A link holds no work. Git lists a symlinked node_modules as untracked, because node_modules/ in .gitignore
    // matches folders only.
    const changed = changes(worktree.path).filter((change) => !(change.status === "??" && isLink(path.join(worktree.path, change.path))));
    if (changed.length > 0) {
      const list = changed.slice(0, 10).map((change) => `  ${change.status} ${change.path}`);
      if (changed.length > 10) list.push(`  … and ${changed.length - 10} more`);
      throw new CommandError(`${target} has changes, so it stays (--force removes it anyway):\n${list.join("\n")}`);
    }
    if (hasSubmodules(worktree.path)) throw new CommandError(`${target} has submodules, so it stays (--force removes it anyway)`);
  }

  // 1. Take out every link, wherever it is. Nothing below can reach the folders they point to after this.
  const root = realPath(worktree.path);
  const targets = new Set<string>();
  for (const link of findLinks(worktree.path)) {
    const to = linkTarget(link);
    // Links to the worktree's own workspace packages go away with it; the others must survive.
    if (to !== undefined && fs.existsSync(to) && within(root, realPath(to)) === undefined) targets.add(to);
    removeLink(link);
    result.unlinked++;
  }

  // 2. Delete the worktree's files, but keep its .git file: if a file is in use, the worktree stays registered
  //    and the command can run again.
  try {
    for (const name of fs.readdirSync(worktree.path)) {
      if (name !== ".git") removeTree(path.join(worktree.path, name));
    }
  } catch (error) {
    throw new CommandError(inUse(error, worktree.path, target, cwd));
  }

  // 3. Let git forget it. The files are gone, so git sees deletions: --force.
  const run = git(gitDir, ["-c", "core.longpaths=true", "worktree", "remove", "--force", worktree.path]);
  if (run.status !== 0) {
    removeTree(worktree.path);
    git(gitDir, ["worktree", "prune"]);
    result.method = "fallback";
    result.notes.push({
      code: "git-failed",
      severity: "info",
      message: `git worktree remove failed (${run.stderr.trim().split("\n")[0]}), so worktree-modules deleted the folder and ran git worktree prune`,
    });
  }

  const lost = [...targets].filter((to) => !fs.existsSync(to));
  if (lost.length > 0) {
    result.ok = false;
    result.notes.push({
      code: "target-lost",
      severity: "error",
      message: `These folders that links pointed to are gone, which should never happen; please report it: ${lost.slice(0, 5).join(", ")}`,
    });
  }
  return result;
}

function hasSubmodules(root: string): boolean {
  if (!fs.existsSync(path.join(root, ".gitmodules"))) return false;
  const run = git(root, ["submodule", "status"]);
  return run.status === 0 && run.stdout.split("\n").some((line) => line !== "" && !line.startsWith("-"));
}

function inUse(error: unknown, worktree: string, target: string, cwd: string): string {
  const file = typeof error === "object" && error !== null && "path" in error ? String((error as { path: unknown }).path) : undefined;
  const lines = [`Cannot delete ${file ? show(file, cwd) : "a file"} (${error instanceof Error ? error.message : String(error)}).`];
  if (hasCode(error, "EBUSY", "EPERM", "EACCES", "ENOTEMPTY")) {
    lines.push("A program still has files of the worktree open: close editors, dev servers and terminals in it.");
    if (isDirectory(path.join(worktree, "android"))) {
      lines.push(`Gradle daemons keep build files open after an Android build: run gradlew --stop in ${show(path.join(worktree, "android"), cwd)}.`);
    }
  }
  lines.push(`The links are out and the worktree is still registered: run worktree-modules remove ${target} --force again.`);
  return lines.join("\n");
}
