export type Severity = "error" | "warning" | "info";

export type NoteCode =
  // add, link
  | "lockfile-drift"
  | "capacitor"
  | "vite"
  | "kept-install"
  | "kept-folder"
  | "missing-workspace"
  | "nothing-to-share"
  | "copy-missing"
  | "link-missing"
  | "copy-hint"
  | "install-failed"
  // remove
  | "git-failed"
  | "target-lost"
  // doctor
  | "single-link"
  | "main-workspace"
  | "broken-links"
  | "outdated-links"
  | "not-linked"
  | "not-copied"
  | "gone";

export interface Note {
  code: NoteCode;
  severity: Severity;
  message: string;
}

export interface FolderResult {
  /** Relative to the worktree, with "/": "node_modules", "packages/ui/node_modules", "ios/App/Pods". */
  path: string;
  /**
   * linked: a real folder with one link per package; folder: one link to the source's folder (the "link" config);
   * kept: left as it was, because it holds a real install or files of its own.
   */
  state: "linked" | "folder" | "kept";
  /** Packages linked to the source checkout's. */
  links: number;
  /** Workspace packages linked to the worktree's own folders, such as "@acme/ui". */
  workspaces: string[];
}

export interface InstallResult {
  /** The folder it ran in, relative to the worktree. */
  dir: string;
  command: string;
  ok: boolean;
}

export interface ShareResult {
  ok: boolean;
  worktree: string;
  source: string;
  /** add: what git did, such as "new branch 'feature'". */
  created?: string;
  folders: FolderResult[];
  /** Paths copied from the source checkout. */
  copied: string[];
  installs: InstallResult[];
  notes: Note[];
}

export interface UnlinkResult {
  ok: boolean;
  worktree: string;
  /** The folders that had links, relative to the worktree. */
  folders: string[];
  unlinked: number;
  notes: Note[];
}

export interface RemoveResult {
  ok: boolean;
  worktree: string;
  /** Links taken out before anything was deleted. */
  unlinked: number;
  /** git: git worktree remove; fallback: deleted by worktree-modules after git failed, then pruned; prune: the folder was already gone. */
  method: "git" | "fallback" | "prune";
  notes: Note[];
}

export interface FolderReport {
  /** Relative to the worktree, with "/". */
  path: string;
  /** links: a real folder of links; link: the folder itself is one link; installed: a real install. */
  kind: "missing" | "link" | "links" | "installed" | "empty";
  links: number;
}

export interface WorktreeReport {
  path: string;
  branch?: string;
  head?: string;
  /** The checkout the others share from. */
  source: boolean;
  folders: FolderReport[];
  notes: Note[];
}

export interface DoctorResult {
  ok: boolean;
  source: string;
  worktrees: WorktreeReport[];
  /** About the project rather than one worktree: Capacitor and Vite. */
  notes: Note[];
  summary: { errors: number; warnings: number; infos: number };
}

/** A command that could not do its job. The CLI prints the message and exits with 1. */
export class CommandError extends Error {}
