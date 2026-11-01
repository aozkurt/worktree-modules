import type { DoctorResult, FolderReport, Note, RemoveResult, ShareResult, UnlinkResult } from "./model.js";
import { show } from "./paths.js";
import type { Style, Symbols } from "./terminal.js";

export interface FormatOptions {
  style: Style;
  symbols: Symbols;
  /** The folder the user is in: paths are shown from there. */
  cwd: string;
  /** How to name the checkout the links point to. Default: "the main checkout". */
  source?: string;
}

export function formatShare(result: ShareResult, options: FormatOptions): string {
  const { style, symbols, cwd } = options;
  const source = options.source ?? "the main checkout";
  const lines: string[] = [];
  const ok = style.green(symbols.ok);
  if (result.created !== undefined) {
    lines.push(`${ok} Created ${style.bold(show(result.worktree, cwd))}${result.created ? `  ${style.dim(`(${result.created})`)}` : ""}`);
  }
  for (const folder of result.folders) {
    if (folder.state === "kept") continue;
    let detail: string;
    if (folder.state === "folder") detail = `one link to ${source}'s`;
    else {
      detail = `${count(folder.links, "package")} from ${source}`;
      if (folder.workspaces.length > 0) detail += `, ${folder.workspaces.length} from this worktree: ${names(folder.workspaces)}`;
    }
    lines.push(`${ok} Linked ${style.bold(folder.path)}  ${style.dim(detail)}`);
  }
  if (result.copied.length > 0) lines.push(`${ok} Copied ${result.copied.join(", ")}`);
  for (const install of result.installs) {
    lines.push(
      install.ok
        ? `${ok} Installed with ${style.bold(install.command)}${install.dir === "." ? "" : `  ${style.dim(`in ${install.dir}`)}`}`
        : `${style.red(symbols.error)} ${install.command} failed${install.dir === "." ? "" : ` in ${install.dir}`}`,
    );
  }
  const notes = result.notes.filter((note) => note.code !== "install-failed");
  if (lines.length === 0 && notes.length === 0) lines.push(`${style.dim(symbols.info)} Nothing to link or copy`);
  lines.push(...notes.map((note) => formatNote(note, options)));
  if (result.created !== undefined && result.ok) {
    lines.push("", style.dim(`Remove it with: npx worktree-modules remove ${show(result.worktree, cwd)}`));
  }
  return `${lines.join("\n")}\n`;
}

export function formatUnlink(result: UnlinkResult, options: FormatOptions): string {
  const { style, symbols } = options;
  const lines =
    result.unlinked > 0
      ? [`${style.green(symbols.ok)} Took out ${count(result.unlinked, "link")} from ${result.folders.join(", ")}`]
      : [`${style.dim(symbols.info)} No links to take out`];
  lines.push(...result.notes.map((note) => formatNote(note, options)));
  return `${lines.join("\n")}\n`;
}

export function formatRemove(result: RemoveResult, options: FormatOptions): string {
  const { style, symbols, cwd } = options;
  const ok = style.green(symbols.ok);
  const lines: string[] = [];
  if (result.unlinked > 0) lines.push(`${ok} Took out ${count(result.unlinked, "link")} first, so nothing they point to was touched`);
  lines.push(...result.notes.map((note) => formatNote(note, options)));
  if (result.method === "prune") lines.push(`${ok} The folder was gone already; git worktree prune forgot ${show(result.worktree, cwd)}`);
  else if (result.ok) lines.push(`${ok} Removed ${style.bold(show(result.worktree, cwd))}`);
  return `${lines.join("\n")}\n`;
}

export function formatDoctor(result: DoctorResult, options: FormatOptions & { version: string }): string {
  const { style, symbols, cwd } = options;
  const rows = result.worktrees.map((worktree) => ({
    worktree,
    where: show(worktree.path, cwd),
    branch: worktree.branch ?? (worktree.head ? `(${worktree.head.slice(0, 7)})` : ""),
  }));
  const pathWidth = Math.max(...rows.map((row) => row.where.length));
  const branchWidth = Math.max(...rows.map((row) => row.branch.length));
  const lines = [style.dim(`worktree-modules ${options.version}`), ""];
  for (const { worktree, where, branch } of rows) {
    const mark = worktree.source ? style.dim(symbols.info) : worstMark(worktree.notes, options);
    const state = worktree.source ? `the main checkout, ${describe(worktree.folders)}` : describe(worktree.folders);
    lines.push(`${mark} ${style.bold(where.padEnd(pathWidth))}  ${style.cyan(branch.padEnd(branchWidth))}  ${style.dim(state)}`.trimEnd());
    for (const note of worktree.notes) lines.push(`    ${formatNote(note, options)}`);
  }
  if (result.notes.length > 0) lines.push("", ...result.notes.map((note) => formatNote(note, options)));

  const { errors, warnings, infos } = result.summary;
  const parts: string[] = [];
  if (errors > 0) parts.push(style.red(`${symbols.error} ${count(errors, "error")}`));
  if (warnings > 0) parts.push(style.yellow(`${symbols.warning} ${count(warnings, "warning")}`));
  if (infos > 0) parts.push(style.cyan(`${symbols.info} ${count(infos, "note")}`));
  if (errors === 0 && warnings === 0) parts.unshift(style.green(`${symbols.ok} No problems`));
  lines.push("", `${parts.join("  ")}  ${style.dim(`(${count(result.worktrees.length, "worktree")})`)}`);
  return `${lines.join("\n")}\n`;
}

function describe(folders: FolderReport[]): string {
  if (folders.length === 0) return "no node_modules to share";
  const word = { missing: "missing", link: "a single link", links: "linked", installed: "installed", empty: "empty" };
  const kinds = new Set(folders.map((folder) => folder.kind));
  if (kinds.size === 1) {
    const kind = folders[0]!.kind;
    return folders.length === 1 ? `${folders[0]!.path} ${word[kind]}` : `${folders.length} node_modules folders ${word[kind]}`;
  }
  return folders.map((folder) => `${folder.path} ${word[folder.kind]}`).join(", ");
}

function worstMark(notes: Note[], { style, symbols }: FormatOptions): string {
  if (notes.some((note) => note.severity === "error")) return style.red(symbols.error);
  if (notes.some((note) => note.severity === "warning")) return style.yellow(symbols.warning);
  return style.green(symbols.ok);
}

export function formatNote(note: Note, { style, symbols }: FormatOptions): string {
  if (note.severity === "error") return `${style.red(symbols.error)} ${note.message}`;
  if (note.severity === "warning") return `${style.yellow(symbols.warning)} ${note.message}`;
  return `${style.cyan(symbols.info)} ${note.message}`;
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function names(list: string[]): string {
  return list.length <= 3 ? list.join(", ") : `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`;
}

