import { readFileSync } from "node:fs";
import path from "node:path";

export interface Config {
  /** Ignored files and folders to copy from the source checkout, such as ".env" or "android/local.properties". `*` matches within a name. */
  copy?: string[];
  /** Ignored folders to share as one link, besides the node_modules folders, such as "ios/App/Pods". */
  link?: string[];
  /** Install instead of linking node_modules: true for the lockfile's clean install (npm ci), or the command to run. */
  install?: boolean | string;
}

export class ConfigError extends Error {}

export const CONFIG_FILE = "worktree-modules.json";

const OPTIONS = ["copy", "link", "install"];

/**
 * Reads `file`, or else the first of `dirs` that has a worktree-modules.json or "worktreeModules" in its package.json.
 * The worktree comes first, so a branch can change its own config, and the source checkout second.
 */
export function loadConfig(dirs: string[], file?: string): { config: Config; file?: string } {
  if (file) {
    const text = read(file);
    if (text === undefined) throw new ConfigError(`Cannot read the config file ${file}`);
    return { config: validate(parse(text, file), file), file };
  }
  for (const dir of dirs) {
    const own = path.join(dir, CONFIG_FILE);
    const text = read(own);
    if (text !== undefined) return { config: validate(parse(text, own), own), file: own };

    const manifest = read(path.join(dir, "package.json"));
    if (manifest === undefined) continue;
    let pkg: unknown;
    try {
      pkg = JSON.parse(manifest);
    } catch {
      continue;
    }
    if (isObject(pkg) && "worktreeModules" in pkg) {
      const name = path.join(dir, "package.json");
      return { config: validate(pkg.worktreeModules, `${name} (worktreeModules)`), file: name };
    }
  }
  return { config: {} };
}

function read(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch {
    return undefined;
  }
}

function parse(text: string, name: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${name}: ${(error as Error).message}`);
  }
}

export function validate(value: unknown, name: string): Config {
  const fail = (message: string): never => {
    throw new ConfigError(`${name}: ${message}`);
  };
  if (!isObject(value)) fail("expected an object");
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (key !== "$schema" && !OPTIONS.includes(key)) fail(`unknown option "${key}" — the options are ${OPTIONS.join(", ")}`);
  }
  const config: Config = {};
  for (const option of ["copy", "link"] as const) {
    const list = object[option];
    if (list === undefined) continue;
    if (!Array.isArray(list) || !list.every((item) => typeof item === "string" && item.trim() !== "")) {
      fail(`"${option}" must be a list of paths such as [".env", "android/local.properties"]`);
    }
    const paths = (list as string[]).map((item) => item.trim().replaceAll("\\", "/").replace(/\/+$/, ""));
    for (const item of paths) {
      if (path.posix.isAbsolute(item) || path.win32.isAbsolute(item) || item.split("/").includes("..")) {
        fail(`"${option}" paths must stay inside the checkout, relative to its root: "${item}"`);
      }
    }
    config[option] = paths;
  }
  if (object.install !== undefined) {
    if (typeof object.install !== "boolean" && (typeof object.install !== "string" || object.install.trim() === "")) {
      fail(`"install" must be true, false or a command such as "npm ci"`);
    }
    config.install = object.install as boolean | string;
  }
  return config;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
