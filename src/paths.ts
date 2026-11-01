import fs from "node:fs";
import path from "node:path";

const caseless = process.platform === "win32" || process.platform === "darwin";

/** The path as the file system knows it: absolute, with Windows short names (RUNNER~1) expanded. */
export function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

export function samePath(a: string, b: string): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return caseless ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** `child` relative to `parent` ("" for the folder itself), or undefined when it is outside. */
export function within(parent: string, child: string): string | undefined {
  const rel = path.relative(parent, child);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
  return rel;
}

/** `p` for messages, with forward slashes: relative to `cwd` when it is near (../feature), else absolute. */
export function show(p: string, cwd: string): string {
  const rel = path.relative(cwd, p);
  const near = !path.isAbsolute(rel) && rel.split(path.sep).filter((part) => part === "..").length <= 2;
  return (rel === "" ? "." : near ? rel : p).split(path.sep).join("/");
}

/** A relative path with forward slashes, the way the config and the output write them. */
export function slash(rel: string): string {
  return rel.split(path.sep).join("/");
}

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
