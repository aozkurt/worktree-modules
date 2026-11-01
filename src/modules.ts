import fs from "node:fs";
import path from "node:path";
import { VERSION } from "./version.js";
import { isLink, lexists, linkTarget, makeLink, removeLink, removeTree } from "./links.js";
import { isDirectory, realPath, within } from "./paths.js";

/** Written into each node_modules folder that worktree-modules fills with links. */
export const MARKER = ".worktree-modules.json";

// Caches that tools write into node_modules. Each worktree builds its own.
const CACHES = new Set([".cache", ".vite", ".vite-temp"]);

/**
 * The node_modules folders of a checkout that hold packages, from git's list of ignored paths: "node_modules",
 * "packages/ui/node_modules". A folder with only caches in it, as test runners leave in workspace packages, is left out.
 */
export function moduleFolders(root: string, ignored: string[]): string[] {
  const folders = ignored
    .filter((p) => p.endsWith("/") && path.posix.basename(p) === "node_modules")
    .map((p) => p.slice(0, -1));
  // A project that does not ignore its node_modules still has one.
  if (!folders.includes("node_modules") && isDirectory(path.join(root, "node_modules"))) folders.unshift("node_modules");
  return folders.filter((rel) =>
    readEntries(path.join(root, rel)).some((entry) => entry.name !== MARKER && !CACHES.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())),
  );
}

export interface FolderInfo {
  /**
   * missing; link: the folder itself is one link; links: a real folder whose packages are links to elsewhere;
   * installed: it has real packages (or links into itself, as pnpm makes); empty.
   */
  kind: "missing" | "link" | "links" | "installed" | "empty";
  /** For "link": where it points. */
  target?: string;
  /** The packages that are links, such as "react" or "@acme/ui", and where they point. */
  links: Map<string, string | undefined>;
}

export function inspectFolder(dir: string): FolderInfo {
  const links = new Map<string, string | undefined>();
  if (!lexists(dir)) return { kind: "missing", links };
  if (isLink(dir)) return { kind: "link", target: linkTarget(dir), links };
  let packages = 0;
  const visit = (name: string, p: string, entry: fs.Dirent) => {
    if (entry.isSymbolicLink()) {
      const target = linkTarget(p);
      // pnpm links its packages into node_modules/.pnpm: those belong to the folder.
      if (target !== undefined && within(dir, target) !== undefined) packages++;
      else links.set(name, target);
    } else if (entry.isDirectory() && name !== ".bin" && !CACHES.has(name)) {
      packages++;
    }
  };
  for (const entry of readEntries(dir)) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name.startsWith("@")) {
      for (const scoped of readEntries(p)) visit(`${entry.name}/${scoped.name}`, path.join(p, scoped.name), scoped);
    } else {
      visit(entry.name, p, entry);
    }
  }
  return { kind: packages > 0 ? "installed" : links.size > 0 ? "links" : "empty", links };
}

interface Planned {
  /** "react", "@types", "@acme/ui" */
  name: string;
  target: string;
  workspace: boolean;
}

/**
 * The links a worktree's copy of the node_modules folder `source` needs: one per package to the source's folder,
 * a whole scope as one link, and for the source's own workspace packages, a link to the worktree's copy of that package.
 */
export function planLinks(sourceRoot: string, worktreeRoot: string, source: string): { links: Planned[]; missing: string[] } {
  const links: Planned[] = [];
  const missing: string[] = [];
  const add = (name: string, from: string) => {
    const target = linkTarget(from);
    const rel = target === undefined ? undefined : workspacePath(sourceRoot, target);
    if (rel === undefined) {
      if (isDirectory(from)) links.push({ name, target: from, workspace: false });
      return;
    }
    const own = path.join(worktreeRoot, rel);
    if (isDirectory(own)) links.push({ name, target: own, workspace: true });
    else missing.push(name);
  };
  for (const entry of readEntries(source)) {
    const name = entry.name;
    if (name === MARKER || name === ".bin" || CACHES.has(name)) continue;
    const from = path.join(source, name);
    if (entry.isDirectory() && name.startsWith("@")) {
      const scoped = readEntries(from);
      if (scoped.some((sub) => sub.isSymbolicLink() && isWorkspaceLink(sourceRoot, path.join(from, sub.name)))) {
        for (const sub of scoped) add(`${name}/${sub.name}`, path.join(from, sub.name));
      } else {
        links.push({ name, target: from, workspace: false });
      }
    } else {
      add(name, from);
    }
  }
  return { links, missing };
}

/**
 * For a link that points into the checkout `root` outside its node_modules folders (a workspace package or a
 * file: dependency), that folder relative to the checkout.
 */
export function workspacePath(root: string, target: string): string | undefined {
  const rel = within(root, realPath(target)) ?? within(root, target);
  if (rel === undefined || rel === "" || rel.split(path.sep).includes("node_modules")) return undefined;
  return rel;
}

function isWorkspaceLink(root: string, p: string): boolean {
  const target = linkTarget(p);
  return target !== undefined && workspacePath(root, target) !== undefined;
}

export interface LinkedFolder {
  state: "linked" | "kept";
  links: number;
  workspaces: string[];
  /** Workspace packages of the source that the worktree does not have. */
  missing: string[];
}

/**
 * Makes `rel` (a node_modules folder) of the worktree a real folder with a link per package of the source's.
 * A real install stays unless `force`. Returns undefined when there is nothing to link: the source has no such
 * folder or only caches in it, or the worktree's branch lacks the folder it would go in.
 */
export function linkFolder(sourceRoot: string, worktreeRoot: string, rel: string, force: boolean): LinkedFolder | undefined {
  const source = path.join(sourceRoot, rel);
  const dir = path.join(worktreeRoot, rel);
  if (!isDirectory(source) || !isDirectory(path.dirname(dir))) return undefined;

  const info = inspectFolder(dir);
  const { links, missing } = planLinks(sourceRoot, worktreeRoot, source);
  if (links.length === 0 && missing.length === 0 && readEntries(path.join(source, ".bin")).length === 0) {
    // Links from an earlier run go; a real install stays.
    if (info.kind === "link" || info.kind === "links") unlinkFolder(dir);
    return undefined;
  }
  if (info.kind === "installed" && !force) return { state: "kept", links: 0, workspaces: [], missing: [] };
  if (info.kind === "link") removeLink(dir);
  if (info.kind === "missing" || info.kind === "link") fs.mkdirSync(dir);
  // Empty it without following links: what it held was links, our marker and .bin, or a real install under --force.
  else for (const name of fs.readdirSync(dir)) removeTree(path.join(dir, name));

  const marker = {
    note: "worktree-modules filled this folder with links to the packages of the source. Remove the worktree with `npx worktree-modules remove`, which takes the links out first.",
    source,
    version: VERSION,
  };
  fs.writeFileSync(path.join(dir, MARKER), `${JSON.stringify(marker, null, 2)}\n`);

  for (const link of links) {
    const at = path.join(dir, link.name);
    if (link.name.includes("/")) fs.mkdirSync(path.dirname(at), { recursive: true });
    makeLink(link.target, at);
  }
  copyBin(path.join(source, ".bin"), path.join(dir, ".bin"));
  return {
    state: "linked",
    links: links.filter((link) => !link.workspace).length,
    workspaces: links.filter((link) => link.workspace).map((link) => link.name),
    missing,
  };
}

// A real .bin folder keeps package managers from writing into the source's. The shims point at ../<package>, which
// resolves through this worktree's links, so the bins of workspace packages run the worktree's code.
function copyBin(from: string, to: string): void {
  const entries = readEntries(from);
  if (entries.length === 0) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of entries) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    try {
      if (entry.isSymbolicLink() && process.platform !== "win32") fs.symlinkSync(fs.readlinkSync(a), b);
      else if (entry.isFile() || entry.isSymbolicLink()) fs.copyFileSync(a, b);
    } catch {
      // A link to nothing.
    }
  }
}

/**
 * Takes the links out of a node_modules folder of a worktree and deletes the folder. A real install stays.
 * Returns the number of links removed, or undefined when it left a real install.
 */
export function unlinkFolder(dir: string): number | undefined {
  const info = inspectFolder(dir);
  if (info.kind === "missing") return 0;
  if (info.kind === "installed") return undefined;
  if (info.kind === "link") {
    removeLink(dir);
    return 1;
  }
  return removeTree(dir).length;
}

function readEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
