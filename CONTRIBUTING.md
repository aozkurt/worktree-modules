# Contributing

Thanks for helping. A bug report with the commands you ran, your OS, Git and Node versions, and what `npx worktree-modules doctor` printed is the most useful thing you can send.

## Setup

You need Node 22 or newer for the tests (the command itself runs on Node 20), and Git.

```sh
npm ci
npm test
npm run build
node dist/cli.js --help
```

`npm run typecheck` checks the types of the source and the tests. The tests make real repositories, worktrees and links in the system temp folder; on Windows the links are real junctions.

## Where things are

| Path | What it does |
| --- | --- |
| `src/main.ts` | The command line: options, output, exit codes |
| `src/share.ts` | `add`, `link` and `unlink` |
| `src/modules.ts` | The links of one `node_modules` folder, and what a folder holds |
| `src/remove.ts` | `remove` |
| `src/doctor.ts` | `doctor` |
| `src/links.ts` | Making, reading and removing links; deleting a folder without following links |
| `src/git.ts` | The git commands it runs |
| `src/project.ts` | Lockfiles, install commands, Capacitor and Vite, files to copy |
| `src/config.ts` | `worktree-modules.json` |
| `src/report.ts` | The output for people |
| `scripts/removal-check.mjs` | Which ways of deleting follow links on your machine |

## Two rules

- Never delete through a link. Code that deletes uses `removeTree` or `removeLink` from `src/links.ts`, which unlink a link instead of entering it. A test of a removal compares the main checkout's files before and after.
- The README says what other tools do only when a check showed it. To add a claim, add the check to `scripts/removal-check.mjs` or a test.

The README shows real output of the demo project in `test/helpers.ts`, and `test/readme.test.ts` checks that it still matches. When the output changes, update the text between the `demo` comments.
