# worktree-modules

[![CI](https://github.com/aozkurt/worktree-modules/actions/workflows/ci.yml/badge.svg)](https://github.com/aozkurt/worktree-modules/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Share `node_modules` across git worktrees on Windows, safely.

```sh
npx worktree-modules add ../feature
```

<!-- demo:add:start -->
```
✔ Created ../feature  (new branch 'feature')
✔ Linked node_modules  312 packages from the main checkout, 2 from this worktree: @acme/core, @acme/ui
✔ Linked packages/ui/node_modules  1 package from the main checkout
✔ Copied .env, android/local.properties
▲ Capacitor: npx cap sync follows the links and writes the shared packages' paths into the native projects (android/capacitor.settings.gradle). Run worktree-modules link ../feature --install before a native build.

Remove it with: npx worktree-modules remove ../feature
```
<!-- demo:add:end -->

The new worktree gets a real `node_modules` folder with a link to each package of the main checkout: junctions on Windows, which need no admin rights or Developer Mode, and symlinks on macOS and Linux. Nothing is copied or installed. Workspace packages link to the worktree's own code. When you are done, `worktree-modules remove` takes every link out before it deletes anything.

No dependencies, any shell, and any worktree manager: it runs on its own or as your manager's [post-create hook](#use-it-with-your-worktree-manager).

## Why

`npm install` in every worktree is slow and fills the disk with copies of the same packages. Linking the main checkout's `node_modules` instead is an old trick, and on Windows it comes with traps. These come from real Capacitor apps:

- **`git worktree remove` deletes what a junction points to.** Git for Windows follows junctions when it deletes a worktree, with or without `--force`. If the worktree's `node_modules` is a junction to the main checkout's, the main checkout's packages are gone. See [what deletes through a junction](#what-deletes-through-a-junction).
- **`npm ci` in that worktree does the same.** It deletes each entry of `node_modules` before it installs, and through one link those entries are the main checkout's packages.
- **`mklink /J` fails from Git Bash.** `cmd //c mklink /J link target` answers `Invalid switch - "link".` worktree-modules makes junctions with Node, from any shell.
- **Workspace packages come from the wrong checkout.** In an npm workspace, `node_modules/@acme/ui` is a link to `packages/ui`. Share the main checkout's `node_modules`, and the worktree builds and tests the main checkout's `packages/ui` instead of its own.
- **Paths over 260 characters.** An Android build leaves paths like `node_modules/<plugin>/android/build/…` that `git worktree remove` cannot delete (`Filename too long`). Git then forgets the worktree anyway and leaves the folder behind.
- **Ignored files are missing.** A new worktree has no `.env` and no `android/local.properties`.
- **Some tools look through the links.** Capacitor's `npx cap sync` writes the main checkout's plugin paths into `android/capacitor.settings.gradle`, and the Vite dev server answers 403 for files under the main checkout's `node_modules`, such as fonts, unless `server.fs.allow` lists it.
- **A branch with other dependencies needs its own install.** The main checkout's packages are wrong for a branch whose lockfile differs.

worktree-modules makes one link per package, which `npm ci` removes without touching the targets. It links workspace packages to the worktree's own folders, removes links before it deletes anything, deletes long paths itself, copies the ignored files you list, and warns about Capacitor, Vite and lockfile drift, with `--install` for a real install when you need one.

## What deletes through a junction

Before the list above was written, each way of deleting a folder ran against a junction to a folder with 4 files, on Windows 10 (build 19045) with Git for Windows 2.52.0, Node 24.13.0, npm 11.6.2 and Windows PowerShell 5.1:

| Command | Deleted the files the junction points to |
| --- | --- |
| `git worktree remove <worktree>`, with or without `--force` | **Yes** |
| `git worktree remove --force` with a junction per package | **Yes**, the files of every linked package |
| `rm -rf <junction>/` in Git Bash, with the trailing slash | **Yes** |
| `npm ci` in a worktree whose `node_modules` is one junction | **Yes**, and then it installed into the worktree |
| `rm -rf <junction>`, or `rm -rf` on the folder that holds it, in Git Bash | No |
| `Remove-Item -Recurse -Force` in PowerShell 5.1, on the junction or its folder | No |
| `rmdir /s /q` in cmd, on the junction or its folder | No |
| `del /s /q <folder>` in cmd | No |
| Node's `fs.rmSync(path, { recursive: true, force: true })`, on the junction or its folder | No |
| `git clean -fdx` in the worktree | No |
| `npm install` in a worktree whose `node_modules` is one junction | No, it replaced the junction with a folder |
| `npm ci` with a junction per package, as worktree-modules makes them | No |

Explorer and other tools were not tested. [`scripts/removal-check.mjs`](scripts/removal-check.mjs) runs these checks on your machine (`node scripts/removal-check.mjs` in a clone), and CI runs it on Windows and Linux. Other versions may behave differently, so worktree-modules relies on none of them: `remove` takes every link out first and then deletes the rest itself, without following links.

## Usage

You need Node 20 or newer and Git 2.36 or newer.

```sh
npx worktree-modules add ../feature            # git worktree add ../feature, then link
npx worktree-modules add ../fix -b fix/login   # a new branch, as git worktree add -b makes it
npx worktree-modules link                      # link the worktree you are in
npx worktree-modules doctor                    # check every worktree
npx worktree-modules unlink                    # take the links out, before an install of its own
npx worktree-modules remove ../feature         # take the links out, then remove the worktree
```

Every command takes `--json` for scripts. The exit code is 0 when it worked (for `doctor`: no errors), 1 when it failed (`doctor`: errors found) and 2 for a usage problem.

### add &lt;path&gt; [&lt;commit-ish&gt;]

Runs `git worktree add` with the same arguments (`-b <branch>` and `--detach` too), then `link`.

### link [&lt;path&gt;]

Links the worktree that holds the path (default: the current folder) to the main checkout, the first one `git worktree list` shows:

- Each ignored `node_modules` folder of the main checkout (`node_modules`, `packages/ui/node_modules`, `functions/node_modules`) gets a real folder in the worktree, with a link to each package. A scope such as `@types` is one link.
- Packages that the main checkout links to its own folders, such as workspace packages and `file:` dependencies, link to the same folders of the worktree. A workspace package that the branch does not have is left out, with a warning.
- `.bin` is a real folder with copies of the main checkout's shims, so the bins of workspace packages run the worktree's code.
- Files at the top of `node_modules` (`.package-lock.json`) stay behind, so npm sees the links as links, and caches (`.cache`, `.vite`) are left for each worktree to build.
- It copies the files and links the folders that the [config](#config) lists.

Run it again whenever you like: after an install in the main checkout, or to redo the links of a worktree that another tool linked. A worktree with an install of its own stays as it is, unless you pass `--force`.

`--install` takes the links out and runs a clean install in the worktree instead: `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable` (or `--frozen-lockfile` for Yarn 1) or `bun install --frozen-lockfile`, by lockfile. `--from <path>` links to another checkout's packages.

### unlink [&lt;path&gt;]

Takes the links out and deletes the linked `node_modules` folders, without touching what they point to. Run it before an install of the worktree's own, or in a worktree manager's pre-remove hook.

### remove &lt;path&gt;

1. Stops if the worktree has changes or untracked files, unless you pass `--force`, as `git worktree remove` does.
2. Takes out every link in the worktree, wherever it is, without entering it.
3. Deletes the worktree's files itself, paths over 260 characters too. If a program holds a file open, it stops here and the worktree stays registered, so you can run it again. After an Android build, run `gradlew --stop` first: Gradle daemons keep build files open.
4. Runs `git worktree remove --force`, so git forgets the worktree.

Then it checks that every folder the links pointed to is still there.

### doctor [&lt;path&gt;]

Lists every worktree with the state of its `node_modules` folders, and what is wrong with them:

<!-- demo:doctor:start -->
```
worktree-modules 0.1.0

● .           main     the main checkout, 2 node_modules folders installed
✔ ../feature  feature  2 node_modules folders linked
✖ ../hotfix   hotfix   node_modules a single link, packages/ui/node_modules missing
    ✖ node_modules is one link to the main checkout's node_modules: npm ci here would empty it, git worktree remove on Windows would delete its files, and the workspace packages @acme/core, @acme/ui come from the main checkout. worktree-modules link ../hotfix replaces it with a link per package.
    ▲ packages/ui/node_modules is missing: worktree-modules link ../hotfix links it
    ▲ .env, android/local.properties are not here: worktree-modules link ../hotfix copies them

▲ Capacitor: npx cap sync follows the links and writes the shared packages' paths into the native projects (android/capacitor.settings.gradle). Run worktree-modules link --install before a native build.

✖ 1 error  ▲ 3 warnings  (3 worktrees)
```
<!-- demo:doctor:end -->

It also finds links to folders that are gone, workspace packages linked to the main checkout's code, packages of the main checkout that are not linked yet, and lockfiles that differ from the main checkout's.

### What a linked worktree looks like

```
feature/
  node_modules/                   a real folder
    .worktree-modules.json        where the links point
    .bin/                         copies of the main checkout's shims
    react         -> app/node_modules/react
    @types        -> app/node_modules/@types
    @acme/
      ui          -> feature/packages/ui
      core        -> feature/packages/core
  packages/ui/node_modules/
    left-pad      -> app/packages/ui/node_modules/left-pad
```

## Config

`worktree-modules.json` at the root of the repository, or `"worktreeModules"` in its package.json:

```json
{
  "copy": [".env", ".env.*", "android/local.properties"],
  "link": ["ios/App/Pods"],
  "install": false
}
```

| Option | What it does |
| --- | --- |
| `copy` | Ignored files and folders to copy from the main checkout. `*` matches within a name. A file that the worktree already has stays as it is. |
| `link` | More ignored folders to share, each as one link, such as `ios/App/Pods`. A `node_modules` folder in this list gets a link per package. |
| `install` | `true` to run a clean install instead of linking, or the command to run, such as `"npm ci --ignore-scripts"`. |

The worktree's config comes first, so a branch can change it, then the main checkout's. `--config <file>` reads another file. Without a `copy` list, `link` names the ignored `.env` and `.properties` files that the worktree lacks.

## Use it with your worktree manager

worktree-modules is not a worktree manager. Keep yours, and let it run `link` after it creates a worktree and `unlink` before it removes one: managers delete worktrees themselves, and the links must be out first. Turn off their own copying or linking of `node_modules`.

**Plain git**: a `.git/hooks/post-checkout` hook. Git runs it for `git worktree add` too, with a previous HEAD of all zeros:

```sh
#!/bin/sh
# Link node_modules in each new worktree.
if [ "$1" = "0000000000000000000000000000000000000000" ]; then
  npx worktree-modules link
fi
```

Then remove worktrees with `npx worktree-modules remove <path>` instead of `git worktree remove`.

**[Worktrunk](https://github.com/max-sixty/worktrunk)**, in `.config/wt.toml`:

```toml
pre-start = "npx worktree-modules link"
pre-remove = "npx worktree-modules unlink"
```

**[workmux](https://github.com/raine/workmux)**, in `.workmux.yaml`:

```yaml
post_create:
  - npx worktree-modules link
pre_remove:
  - npx worktree-modules unlink
```

**[treehouse](https://github.com/kunchenguid/treehouse)**, in `~/.config/treehouse/config.toml` (treehouse reads hooks from the user config only):

```toml
[hooks]
post_create = ["npx worktree-modules link"]
pre_destroy = ["npx worktree-modules unlink"]
```

treehouse goes on when a hook fails, so if `pre_destroy` reports an error, check the main checkout's `node_modules`.

**[git-worktree-runner](https://github.com/coderabbitai/git-worktree-runner)**:

```sh
git gtr config add gtr.hook.postCreate 'npx worktree-modules link "$WORKTREE_PATH"'
git gtr config add gtr.hook.preRemove 'npx worktree-modules unlink "$WORKTREE_PATH"'
```

## How it differs

The worktree managers do far more than this tool. What they do with `node_modules`, from their documentation in November 2026:

- **Worktrunk** shares build caches with `wt step copy-ignored`, which copies the main worktree's ignored files. It reflinks them on APFS, btrfs, XFS and ReFS, where a copy costs no disk; on NTFS and ext4 it copies every file in full.
- **workmux** opens each worktree in a tmux (or Zellij, kitty, WezTerm) window, and its `files` setting copies or symlinks files such as `.env` and `node_modules` into new worktrees.
- **treehouse** keeps a pool of worktrees that keep their dependencies and build caches between uses, so a reused worktree needs no install. Its opt-in APFS sharing covers large tracked files, not `node_modules`.
- **git-worktree-runner** copies the folders in `gtr.copy.includeDirs`, such as `node_modules`, with `cp -r`.

worktree-modules does one thing: it shares `node_modules` without copies on NTFS, where reflinks are not available, and handles what comes with links: workspace packages, `npm ci` and removal. Use it alone or as a hook of any of them.

## Limits

- The packages are shared. A postinstall script, `patch-package` or a generated client (Prisma) that writes into `node_modules` in one worktree changes it for all of them.
- A worktree has the packages the main checkout had when it was linked. After an install in the main checkout, run `link` again; `doctor` tells you which worktrees need it.
- A branch with other dependencies needs `link --install`. `link` and `doctor` warn when its lockfile differs from the main checkout's.
- Native builds read and write inside `node_modules` (Capacitor's `cap sync`, Gradle): use `--install` for them.
- Junctions work on local drives, not on network shares.
- Moving the main checkout breaks the links: run `link` again.
- It is tested with npm. pnpm, Yarn and Bun keep their packages in `node_modules` folders too and should work the same way, but they are not tested yet. Yarn Plug'n'Play has no `node_modules` to share.
- Other tools still follow junctions when they delete a worktree: use `worktree-modules remove`, or `unlink` in your manager's pre-remove hook.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
