import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, validate } from "../src/config.js";
import { tempDir, write } from "./helpers.js";

describe("config", () => {
  it("reads worktree-modules.json, then package.json, from the first folder that has one", () => {
    const worktree = tempDir();
    const source = tempDir();
    write(source, { "worktree-modules.json": '{ "copy": [".env"] }' });
    expect(loadConfig([worktree, source])).toEqual({ config: { copy: [".env"] }, file: path.join(source, "worktree-modules.json") });

    write(worktree, { "package.json": JSON.stringify({ name: "app", worktreeModules: { install: true } }) });
    expect(loadConfig([worktree, source]).config).toEqual({ install: true });

    write(worktree, { "worktree-modules.json": '\uFEFF{ "link": ["ios/App/Pods/"] }' });
    expect(loadConfig([worktree, source]).config).toEqual({ link: ["ios/App/Pods"] });
    expect(loadConfig([tempDir()])).toEqual({ config: {} });
  });

  it("reads the file it is given", () => {
    const dir = tempDir();
    write(dir, { "custom.json": '{ "install": "pnpm install --offline" }' });
    expect(loadConfig([], path.join(dir, "custom.json")).config).toEqual({ install: "pnpm install --offline" });
    expect(() => loadConfig([], path.join(dir, "missing.json"))).toThrow(/Cannot read the config file/);
  });

  it("explains what is wrong", () => {
    const check = (value: unknown) => () => validate(value, "worktree-modules.json");
    expect(check([])).toThrow(ConfigError);
    expect(check([])).toThrow("worktree-modules.json: expected an object");
    expect(check({ copyFiles: [] })).toThrow('unknown option "copyFiles" — the options are copy, link, install');
    expect(check({ copy: ".env" })).toThrow('"copy" must be a list of paths');
    expect(check({ link: ["../shared"] })).toThrow('"link" paths must stay inside the checkout');
    expect(check({ copy: ["C:\\secrets\\.env"] })).toThrow('"copy" paths must stay inside the checkout');
    expect(check({ install: "" })).toThrow('"install" must be true, false or a command');
    expect(validate({ $schema: "x", copy: ["android\\local.properties"] }, "x")).toEqual({ copy: ["android/local.properties"] });
  });

  it("reports a file that is not JSON", () => {
    const dir = tempDir();
    write(dir, { "worktree-modules.json": "{ copy: [] }" });
    expect(() => loadConfig([dir])).toThrow(/worktree-modules\.json: .*JSON/);
  });
});
