# Changelog

## 0.1.0 (unreleased)

The first version.

- `add`, `link`, `unlink`, `remove` and `doctor`, with `--json` output.
- A link per package (junctions on Windows, symlinks elsewhere) for each `node_modules` folder of the main checkout; workspace packages link to the worktree's own folders.
- `remove` takes every link out before it deletes anything, and deletes paths over 260 characters itself.
- A config to copy ignored files, link more folders, or install instead of linking.
- Warnings for lockfile drift, Capacitor and Vite.
