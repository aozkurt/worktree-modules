import fs from "node:fs";
import path from "node:path";
import { slash } from "./paths.js";

export const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

export function findLockfile(dir: string): string | undefined {
  return LOCKFILES.find((name) => fs.existsSync(path.join(dir, name)));
}

/** The clean install for the lockfile in `dir`. */
export function installCommand(dir: string): string {
  switch (findLockfile(dir)) {
    case "pnpm-lock.yaml":
      return "pnpm install --frozen-lockfile";
    case "yarn.lock":
      return fs.existsSync(path.join(dir, ".yarnrc.yml")) ? "yarn install --immutable" : "yarn install --frozen-lockfile";
    case "bun.lock":
    case "bun.lockb":
      return "bun install --frozen-lockfile";
    case undefined:
      return "npm install";
    default:
      return "npm ci";
  }
}

/** The lockfiles in `dirs` (relative to both checkouts) that differ between them, relative with "/". */
export function lockfileDrift(source: string, worktree: string, dirs: string[]): string[] {
  const drift: string[] = [];
  for (const dir of dirs) {
    for (const name of LOCKFILES) {
      const theirs = read(path.join(source, dir, name));
      const ours = read(path.join(worktree, dir, name));
      if (theirs === undefined && ours === undefined) continue;
      if (theirs === undefined || ours === undefined || !theirs.equals(ours)) drift.push(slash(path.join(dir, name)));
    }
  }
  return drift;
}

// With core.autocrlf, a new checkout has CRLF where npm wrote LF in the main checkout: the same lockfile.
function read(file: string): Buffer | undefined {
  try {
    const bytes = fs.readFileSync(file);
    return file.endsWith(".lockb") ? bytes : Buffer.from(bytes.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
  } catch {
    return undefined;
  }
}

export interface Tools {
  capacitor: boolean;
  vite: boolean;
}

/** Tools that resolve the links to the source checkout's real paths, found in any of the project folders `dirs`. */
export function detectTools(dirs: string[]): Tools {
  const tools: Tools = { capacitor: false, vite: false };
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const dependencies = readDependencies(dir);
    if (names.some((name) => /^capacitor\.config\.(ts|js|json)$/.test(name)) || dependencies.has("@capacitor/core")) tools.capacitor = true;
    if (names.some((name) => /^vite\.config\.[cm]?[jt]s$/.test(name)) || dependencies.has("vite")) tools.vite = true;
  }
  return tools;
}

function readDependencies(dir: string): Set<string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
    const names = new Set<string>();
    for (const field of ["dependencies", "devDependencies"]) {
      const deps = pkg[field];
      if (typeof deps === "object" && deps !== null) for (const name of Object.keys(deps)) names.add(name);
    }
    return names;
  } catch {
    return new Set();
  }
}

// Files that apps keep out of git but need to run or build: .env, android/local.properties, Firebase configs.
const LOCAL_FILES = [/^\.env(\..+)?$/, /\.properties$/, /^google-services\.json$/, /^GoogleService-Info\.plist$/];

/** The ignored files (from git, relative with "/") that a new worktree probably needs a copy of. */
export function localFiles(ignored: string[]): string[] {
  return ignored.filter((p) => !p.endsWith("/") && LOCAL_FILES.some((pattern) => pattern.test(path.posix.basename(p))));
}

/** Expands a config path with `*` wildcards against the files in `root`. */
export function expand(root: string, pattern: string): string[] {
  let found = [""];
  for (const segment of pattern.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (!segment.includes("*")) {
      found = found.map((rel) => path.join(rel, segment));
      continue;
    }
    const regex = new RegExp(`^${segment.split("*").map(escape).join(".*")}$`);
    found = found.flatMap((rel) => {
      try {
        return fs
          .readdirSync(path.join(root, rel))
          .filter((name) => regex.test(name))
          .sort()
          .map((name) => path.join(rel, name));
      } catch {
        return [];
      }
    });
  }
  return found.filter((rel) => rel !== "" && fs.existsSync(path.join(root, rel)));
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `rel` (a path relative to the checkout, with "/") is matched by one of the config `patterns`. */
export function matches(rel: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const regex = new RegExp(`^${pattern.split("*").map(escape).join("[^/]*")}(/.*)?$`);
    return regex.test(rel);
  });
}
