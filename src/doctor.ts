import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { checkoutRoot, ignoredPaths, listWorktrees } from "./git.js";
import { lexists } from "./links.js";
import { CommandError, type DoctorResult, type Note, type WorktreeReport } from "./model.js";
import { inspectFolder, moduleFolders, planLinks, workspacePath } from "./modules.js";
import { isDirectory, realPath, samePath, show, slash, within } from "./paths.js";
import { detectTools, expand, localFiles, lockfileDrift, matches } from "./project.js";
import { capacitorNote, suggest, viteNote } from "./share.js";

export interface DoctorOptions {
  /** Compare with this checkout instead of the main checkout. */
  from?: string;
  config?: string;
  /** The folder the user is in, for the paths and commands in messages. Default: process.cwd(). */
  cwd?: string;
}

/** Checks the links of every worktree of the repository that holds `target`. */
export function doctor(target: string, options: DoctorOptions = {}): DoctorResult {
  const cwd = options.cwd ?? process.cwd();
  if (!isDirectory(target) || !checkoutRoot(target)) throw new CommandError(`${target} is not in a git checkout`);
  const worktrees = listWorktrees(target);
  let source: string;
  if (options.from !== undefined) {
    const root = isDirectory(options.from) ? checkoutRoot(options.from) : undefined;
    if (!root) throw new CommandError(`--from ${options.from} is not a git checkout`);
    source = realPath(root);
  } else {
    const main = worktrees[0];
    if (!main || main.bare) throw new CommandError("The repository is bare, so there is no main checkout to compare with: pass --from <checkout>");
    source = realPath(main.path);
  }
  const ignored = ignoredPaths(source);
  const folders = moduleFolders(source, ignored);
  const result: DoctorResult = { ok: true, source, worktrees: [], notes: [], summary: { errors: 0, warnings: 0, infos: 0 } };

  let anyLinked = false;
  for (const worktree of worktrees) {
    if (worktree.bare) continue;
    const root = realPath(worktree.path);
    const report: WorktreeReport = {
      path: worktree.path,
      branch: worktree.branch,
      head: worktree.head,
      source: samePath(root, source),
      folders: [],
      notes: [],
    };
    result.worktrees.push(report);
    if (!isDirectory(root)) {
      report.notes.push({ code: "gone", severity: "warning", message: "The folder is gone: git worktree prune forgets it" });
      continue;
    }
    for (const rel of folders) {
      const dir = path.join(root, rel);
      if (!isDirectory(path.dirname(dir))) continue;
      const info = inspectFolder(dir);
      report.folders.push({ path: slash(rel), kind: info.kind, links: info.links.size });
      if (report.source) continue;
      if (info.kind === "link" || info.kind === "links") anyLinked = true;
      report.notes.push(...checkFolder(source, root, rel, info, cwd));
    }
    if (report.source) continue;
    const { config } = loadConfig([root, source], options.config);
    if (report.folders.some((folder) => folder.kind === "link" || folder.kind === "links")) {
      const projects = [...new Set(["", ...folders.map((rel) => path.dirname(rel)).map((dir) => (dir === "." ? "" : dir))])];
      for (const file of lockfileDrift(source, root, projects)) {
        report.notes.push({
          code: "lockfile-drift",
          severity: "warning",
          message: `${file} differs from the main checkout's, so the linked packages may not match this branch: run ${suggest("link", root, { cwd }, "--install")} for a real install`,
        });
      }
    }
    const absent = (config.copy ?? []).flatMap((pattern) => expand(source, pattern)).filter((rel) => !lexists(path.join(root, rel)));
    if (absent.length > 0) {
      report.notes.push({
        code: "not-copied",
        severity: "warning",
        message: `${absent.map(slash).join(", ")} ${absent.length === 1 ? "is" : "are"} not here: ${suggest("link", root, { cwd })} copies ${absent.length === 1 ? "it" : "them"}`,
      });
    }
    const local = localFiles(ignored).filter((rel) => !lexists(path.join(root, rel)) && !matches(rel, config.copy ?? []));
    if (local.length > 0) {
      report.notes.push({
        code: "copy-hint",
        severity: "info",
        message: `Ignored files of the main checkout that this worktree lacks: ${local.join(", ")}. List them under "copy" in worktree-modules.json to copy them.`,
      });
    }
  }

  if (anyLinked) {
    const tools = detectTools([...new Set(["", ...folders.map((rel) => path.dirname(rel))])].map((dir) => path.join(source, dir)));
    if (tools.capacitor) result.notes.push(capacitorNote("worktree-modules link --install"));
    if (tools.vite) result.notes.push(viteNote(source));
  }

  for (const note of [...result.notes, ...result.worktrees.flatMap((worktree) => worktree.notes)]) {
    if (note.severity === "error") result.summary.errors++;
    else if (note.severity === "warning") result.summary.warnings++;
    else result.summary.infos++;
  }
  result.ok = result.summary.errors === 0;
  return result;
}

function checkFolder(source: string, root: string, rel: string, info: ReturnType<typeof inspectFolder>, cwd: string): Note[] {
  const notes: Note[] = [];
  const name = slash(rel);
  const relink = suggest("link", root, { cwd });
  if (info.kind === "missing" || info.kind === "empty") {
    notes.push({ code: "not-linked", severity: "warning", message: `${name} is ${info.kind === "missing" ? "missing" : "empty"}: ${relink} links it` });
  } else if (info.kind === "link") {
    const target = info.target ?? "";
    const fromMain = isDirectory(target) ? [...inspectFolder(target).links].filter(([, to]) => isMainWorkspace(source, root, to)).map(([pkg]) => pkg) : [];
    const consequences = ["npm ci here would empty it", "git worktree remove from Git for Windows before 2.54 would delete its files"];
    if (fromMain.length > 0) consequences.push(`the workspace packages ${list(fromMain)} come from the main checkout`);
    const where = samePath(realPath(target), path.join(source, rel)) ? `the main checkout's ${name}` : show(target, cwd);
    notes.push({
      code: "single-link",
      severity: "error",
      message: `${name} is one link to ${where}: ${join(consequences)}. ${relink} replaces it with a link per package.`,
    });
  } else if (info.kind === "links") {
    const broken = [...info.links].filter(([, to]) => to === undefined || !fs.existsSync(to)).map(([pkg]) => pkg);
    if (broken.length > 0) {
      notes.push({
        code: "broken-links",
        severity: "error",
        message: `${name} has ${broken.length} ${broken.length === 1 ? "link" : "links"} to folders that are gone (${list(broken)}): ${relink} redoes them`,
      });
    }
    const fromMain = [...info.links].filter(([, to]) => isMainWorkspace(source, root, to)).map(([pkg]) => pkg);
    if (fromMain.length > 0) {
      notes.push({
        code: "main-workspace",
        severity: "error",
        message: `${list(fromMain)} in ${name} ${fromMain.length === 1 ? "is" : "are"} the main checkout's, not this worktree's: ${relink} links this worktree's own`,
      });
    }
    const missing = planLinks(source, root, path.join(source, rel)).links.filter((link) => !lexists(path.join(root, rel, link.name)));
    if (missing.length > 0) {
      notes.push({
        code: "outdated-links",
        severity: "warning",
        message: `${missing.length} ${missing.length === 1 ? "package" : "packages"} of the main checkout ${missing.length === 1 ? "is" : "are"} not linked in ${name} (${list(missing.map((link) => link.name))}): ${relink} adds them`,
      });
    }
  }
  return notes;
}

// A link of the worktree into the source checkout's own folders: a workspace package from the wrong checkout.
function isMainWorkspace(source: string, root: string, to: string | undefined): boolean {
  return to !== undefined && within(root, realPath(to)) === undefined && workspacePath(source, to) !== undefined;
}

function list(names: string[]): string {
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

function join(parts: string[]): string {
  if (parts.length <= 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

