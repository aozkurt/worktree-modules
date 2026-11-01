import { spawnSync } from "node:child_process";
import path from "node:path";

// Git sets these for hooks. They would point our commands at the repository that ran the hook,
// so a post-checkout hook that calls worktree-modules would link the wrong checkout.
const HOOK_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"];

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {}

export function git(cwd: string, args: string[]): GitResult {
  const env = { ...process.env };
  for (const name of HOOK_VARIABLES) delete env[name];
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new GitError(`Cannot run git: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function output(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  if (result.status !== 0) throw new GitError(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout;
}

export interface Worktree {
  path: string;
  head?: string;
  /** The branch without refs/heads/. */
  branch?: string;
  bare: boolean;
  detached: boolean;
  /** The reason, or "" when it is locked without one. */
  locked?: string;
  prunable?: string;
  /** The first worktree git lists: the main checkout, or the bare repository. */
  main: boolean;
}

export function listWorktrees(cwd: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Worktree | undefined;
  for (const line of output(cwd, ["worktree", "list", "--porcelain", "-z"]).split("\0")) {
    if (line === "") {
      current = undefined;
      continue;
    }
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "" : line.slice(space + 1);
    if (key === "worktree") {
      current = { path: path.resolve(value), bare: false, detached: false, main: worktrees.length === 0 };
      worktrees.push(current);
    } else if (current) {
      if (key === "HEAD") current.head = value;
      else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "bare") current.bare = true;
      else if (key === "detached") current.detached = true;
      else if (key === "locked") current.locked = value;
      else if (key === "prunable") current.prunable = value;
    }
  }
  return worktrees;
}

/** The root of the checkout that holds `dir`, or undefined outside a git checkout. */
export function checkoutRoot(dir: string): string | undefined {
  const result = git(dir, ["rev-parse", "--show-toplevel"]);
  const root = result.stdout.trim();
  return result.status === 0 && root !== "" ? path.resolve(root) : undefined;
}

/** The ignored files and folders of a checkout, relative with "/". Folders end with "/", and git does not list what is in them. */
export function ignoredPaths(root: string): string[] {
  return output(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]).split("\0").filter(Boolean);
}

export interface Change {
  /** The two status letters of `git status --porcelain`, such as " M" or "??". */
  status: string;
  /** Relative to the checkout, with "/". */
  path: string;
}

/** Modified and untracked files. */
export function changes(root: string): Change[] {
  const entries = output(root, ["status", "--porcelain", "-z", "--ignore-submodules=none"]).split("\0");
  const found: Change[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry === "") continue;
    const status = entry.slice(0, 2);
    found.push({ status, path: entry.slice(3) });
    // A rename or a copy is followed by the path it came from.
    if (status.includes("R") || status.includes("C")) i++;
  }
  return found;
}
