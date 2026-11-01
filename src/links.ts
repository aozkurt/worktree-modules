import fs from "node:fs";
import path from "node:path";

// Junctions need no admin rights or Developer Mode on Windows, and only link folders, which is all we link.
const TYPE = process.platform === "win32" ? "junction" : "dir";

export function makeLink(target: string, link: string): void {
  fs.symlinkSync(target, link, TYPE);
}

export function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether something is at `p`, even a link to nothing. */
export function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Where the link at `p` points, as an absolute path, or undefined when `p` is not a link. */
export function linkTarget(p: string): string | undefined {
  try {
    return path.resolve(path.dirname(p), fs.readlinkSync(p));
  } catch {
    return undefined;
  }
}

/** Removes the link itself and never what it points to. */
export function removeLink(p: string): void {
  retry(() => {
    try {
      fs.unlinkSync(p);
    } catch (error) {
      // Some directory links refuse unlink on Windows; rmdir removes the link without entering it.
      if (process.platform === "win32" && hasCode(error, "EPERM", "EISDIR")) fs.rmdirSync(p);
      else throw error;
    }
  });
}

/**
 * Deletes `p` and everything in it without following links: a link is unlinked, never entered.
 * Node handles paths longer than 260 characters on Windows, where git and Explorer fail.
 * Returns the links it removed.
 */
export function removeTree(p: string, unlinked: string[] = []): string[] {
  let stat;
  try {
    stat = fs.lstatSync(p);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return unlinked;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    removeLink(p);
    unlinked.push(p);
  } else if (stat.isDirectory()) {
    removeFolder(p, unlinked);
  } else {
    removeFile(p);
  }
  return unlinked;
}

function removeFolder(dir: string, unlinked: string[]): void {
  // The entry types come with the listing (a junction is a link on Windows too), so files need no stat call.
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      removeLink(p);
      unlinked.push(p);
    } else if (entry.isDirectory()) {
      removeFolder(p, unlinked);
    } else {
      removeFile(p);
    }
  }
  retry(() => fs.rmdirSync(dir));
}

function removeFile(p: string): void {
  retry(() => {
    try {
      fs.unlinkSync(p);
    } catch (error) {
      // A read-only file on Windows.
      if (!hasCode(error, "EPERM")) throw error;
      fs.chmodSync(p, 0o666);
      fs.unlinkSync(p);
    }
  });
}

/** Every link under `root`, without entering any of them. Skips the .git of the root. */
export function findLinks(root: string): string[] {
  const links: string[] = [];
  const folders = [root];
  for (let dir = folders.pop(); dir !== undefined; dir = folders.pop()) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT", "ENOTDIR")) continue;
      throw error;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) links.push(p);
      else if (entry.isDirectory() && !(dir === root && entry.name === ".git")) folders.push(p);
    }
  }
  return links;
}

/** Copies a file or folder. Links inside a folder are left out: a copy should not lead back into the source. */
export function copyTree(from: string, to: string): void {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      copyTree(path.join(from, entry.name), path.join(to, entry.name));
    }
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

export function hasCode(error: unknown, ...codes: string[]): boolean {
  return typeof error === "object" && error !== null && codes.includes((error as { code?: string }).code ?? "");
}

// Antivirus scanners and indexers hold files open for a moment on Windows.
function retry(action: () => void): void {
  for (let attempt = 1; ; attempt++) {
    try {
      action();
      return;
    } catch (error) {
      if (attempt === 5 || !hasCode(error, "EBUSY", "EPERM", "EACCES", "ENOTEMPTY")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 100);
    }
  }
}
