import path from "node:path";
import { parseArgs } from "node:util";
import { ConfigError } from "./config.js";
import { doctor } from "./doctor.js";
import { GitError } from "./git.js";
import { CommandError } from "./model.js";
import { show } from "./paths.js";
import { remove } from "./remove.js";
import { type FormatOptions, formatDoctor, formatRemove, formatShare, formatUnlink } from "./report.js";
import { add, link, unlink } from "./share.js";
import { createStyle, createSymbols, supportsUnicode, wantsColor } from "./terminal.js";
import { VERSION } from "./version.js";

export interface Io {
  stdout: { write(text: string): unknown; isTTY?: boolean };
  stderr: { write(text: string): unknown };
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform: NodeJS.Platform;
}

const HELP = `worktree-modules ${VERSION}
Share node_modules across git worktrees, safely: links instead of copies, junctions on Windows.

Usage
  npx worktree-modules add <path> [<commit-ish>]  Create a worktree (git worktree add), then link it
  npx worktree-modules link [<path>]              Link a worktree (default: the one you are in)
  npx worktree-modules unlink [<path>]            Take the links out, before an install of its own
  npx worktree-modules remove <path>              Take the links out, then remove the worktree
  npx worktree-modules doctor                     Check the links of every worktree

Each node_modules folder of the worktree becomes a real folder with a link to each package
of the main checkout's. Workspace packages link to the worktree's own folders.

Options
  -b, --branch <name>   add: create this branch, as git worktree add -b does
      --detach          add: check out a detached HEAD
      --install         add, link: run a clean install (npm ci) instead of linking
  -f, --force           link: replace a real install with links
                        remove: remove the worktree even when it has changes
      --from <path>     Share from this checkout instead of the main checkout
  -c, --config <file>   Config file (default: worktree-modules.json, or "worktreeModules"
                        in package.json)
      --json            Print the result as JSON
      --no-color        Plain text output
  -h, --help            Show this help
  -v, --version         Show the version

Exit codes
  0  done (doctor: no errors)
  1  failed (doctor: errors found)
  2  usage problem

https://github.com/aozkurt/worktree-modules
`;

const COMMANDS = ["add", "link", "unlink", "remove", "doctor"];

// The commands each option works with, and how many paths each command takes.
const ONLY: Record<string, string[]> = {
  branch: ["add"],
  detach: ["add"],
  install: ["add", "link"],
  force: ["add", "link", "remove"],
  from: ["add", "link", "unlink", "doctor"],
  config: ["add", "link", "unlink", "doctor"],
};
const ARGUMENTS: Record<string, [min: number, max: number, usage: string]> = {
  add: [1, 2, "add <path> [<commit-ish>]"],
  link: [0, 1, "link [<path>]"],
  unlink: [0, 1, "unlink [<path>]"],
  remove: [1, 1, "remove <path>"],
  doctor: [0, 1, "doctor [<path>]"],
};

/** Runs the command line with `argv` (without node and the script) and returns the exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  const fail = (message: string) => {
    io.stderr.write(`worktree-modules: ${message}\n`);
    return 2;
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        branch: { type: "string", short: "b" },
        detach: { type: "boolean" },
        install: { type: "boolean" },
        force: { type: "boolean", short: "f" },
        from: { type: "string" },
        config: { type: "string", short: "c" },
        json: { type: "boolean" },
        color: { type: "boolean" },
        "no-color": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    return fail(`${(error as Error).message}\nRun worktree-modules --help to see the options.`);
  }
  const { values, positionals } = parsed;

  if (values.help) {
    io.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const [command, ...args] = positionals;
  if (command === undefined) {
    io.stdout.write(HELP);
    return 2;
  }
  if (!COMMANDS.includes(command)) return fail(`unknown command "${command}" — the commands are ${COMMANDS.join(", ")}`);
  for (const [option, commands] of Object.entries(ONLY)) {
    if (values[option as keyof typeof values] !== undefined && !commands.includes(command)) {
      return fail(`--${option} works with ${commands.join(", ")}, not ${command}`);
    }
  }
  const [min, max, usage] = ARGUMENTS[command]!;
  if (args.length < min || args.length > max) return fail(`usage: worktree-modules ${usage}`);
  if (values.branch !== undefined && values.detach) return fail("--branch and --detach do not go together");

  const color = values["no-color"] ? false : values.color ? true : wantsColor(io.env, io.stdout.isTTY);
  const format: FormatOptions = {
    style: createStyle(color),
    symbols: createSymbols(supportsUnicode(io.env, io.platform)),
    cwd: io.cwd,
    source: values.from === undefined ? undefined : show(path.resolve(io.cwd, values.from), io.cwd),
  };
  const shared = {
    from: values.from === undefined ? undefined : path.resolve(io.cwd, values.from),
    config: values.config === undefined ? undefined : path.resolve(io.cwd, values.config),
    cwd: io.cwd,
  };
  const print = <T>(result: T, human: (result: T) => string) => {
    io.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : human(result));
  };

  try {
    switch (command) {
      case "add": {
        const result = add(io.cwd, args[0]!, {
          ...shared,
          commitish: args[1],
          branch: values.branch,
          detach: values.detach,
          install: values.install,
          force: values.force,
          installOutput: values.json ? "stderr" : "inherit",
        });
        print(result, (r) => formatShare(r, format));
        return result.ok ? 0 : 1;
      }
      case "link": {
        const result = link(path.resolve(io.cwd, args[0] ?? "."), {
          ...shared,
          install: values.install,
          force: values.force,
          installOutput: values.json ? "stderr" : "inherit",
        });
        print(result, (r) => formatShare(r, format));
        return result.ok ? 0 : 1;
      }
      case "unlink": {
        const result = unlink(path.resolve(io.cwd, args[0] ?? "."), shared);
        print(result, (r) => formatUnlink(r, format));
        return result.ok ? 0 : 1;
      }
      case "remove": {
        const result = remove(args[0]!, { force: values.force, cwd: io.cwd });
        print(result, (r) => formatRemove(r, format));
        return result.ok ? 0 : 1;
      }
      default: {
        const result = doctor(path.resolve(io.cwd, args[0] ?? "."), shared);
        print(result, (r) => formatDoctor(r, { ...format, version: VERSION }));
        return result.ok ? 0 : 1;
      }
    }
  } catch (error) {
    if (!(error instanceof CommandError || error instanceof ConfigError || error instanceof GitError)) throw error;
    if (values.json) io.stdout.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    else io.stderr.write(`${format.style.red(format.symbols.error)} ${error.message}\n`);
    return 1;
  }
}
