import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findLinks, removeLink, removeTree } from "../src/links.js";
import { junction, listFiles, tempDir, write } from "./helpers.js";

function setup() {
  const root = tempDir();
  const shared = path.join(root, "shared");
  write(shared, { "marker.txt": "keep", "pkg/index.js": "keep", "pkg/deep/file.txt": "keep" });
  const tree = path.join(root, "tree");
  write(tree, { "own.txt": "mine", "a/b/c.txt": "mine" });
  junction(shared, path.join(tree, "link"));
  junction(shared, path.join(tree, "a", "b", "nested-link"));
  return { root, shared, tree };
}

describe("link helpers", () => {
  it("removeTree deletes a folder and unlinks the links in it without entering them", () => {
    const { shared, tree } = setup();
    const unlinked = removeTree(tree);
    expect(unlinked.map((p) => path.relative(tree, p)).sort()).toEqual([path.join("a", "b", "nested-link"), "link"]);
    expect(fs.existsSync(tree)).toBe(false);
    expect(listFiles(shared)).toEqual(["marker.txt", "pkg/deep/file.txt", "pkg/index.js"]);
  });

  it("removeTree and removeLink take out a link given directly", () => {
    const { shared, tree } = setup();
    expect(removeTree(path.join(tree, "link"))).toEqual([path.join(tree, "link")]);
    removeLink(path.join(tree, "a", "b", "nested-link"));
    expect(fs.readdirSync(path.join(tree, "a", "b"))).toEqual(["c.txt"]);
    expect(listFiles(shared)).toHaveLength(3);
  });

  it("findLinks finds links at any depth and does not enter them", () => {
    const { tree } = setup();
    expect(findLinks(tree).map((p) => path.relative(tree, p)).sort()).toEqual([path.join("a", "b", "nested-link"), "link"]);
  });
});
