import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTestFixture } from "../test-cleanup";
import { cloudPlaces, gitRemoteUrls, localRepositories, repositoryKey } from "./claude-cloud-places";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTestFixture(root, { recursive: true, force: true }); });

const source = (url: string) => ({ type: "git_repository", url });

describe("repositoryKey", () => {
  test("HTTPS, SSH and .git forms name the same repository", () => {
    expect(repositoryKey("https://github.com/KNODEdev/TactShift")).toBe("github.com/knodedev/tactshift");
    expect(repositoryKey("https://github.com/KNODEdev/TactShift.git")).toBe("github.com/knodedev/tactshift");
    expect(repositoryKey("git@github.com:KNODEdev/TactShift.git")).toBe("github.com/knodedev/tactshift");
    expect(repositoryKey("not a url")).toBeNull();
  });
});

describe("cloudPlaces", () => {
  const clones = new Map([
    ["github.com/knodedev/tactshift", ["H:/repos/products/TactShift-feature", "H:/repos/products/TactShift"]],
    ["github.com/knodedev/agentroad", ["H:/repos/products/Agentroad"]],
  ]);
  test("maps the container checkout to the clone named like the repository", () => {
    expect(cloudPlaces([source("https://github.com/KNODEdev/TactShift")], clones)).toEqual([
      { repository: "https://github.com/KNODEdev/TactShift", remote: "/home/user/TactShift", local: "H:/repos/products/TactShift" }]);
  });
  test("owners differ only in case still need the exact URL; unknown repositories stay unresolved", () => {
    expect(cloudPlaces([source("https://github.com/Kaltorre/_SKILS"), source("https://github.com/KNODEdev/_skils")], clones)
      .map(place => [place.remote, place.local])).toEqual([["/home/user/_SKILS", null], ["/home/user/_skils", null]]);
  });
  test("aliases follow a repository moved between owners; explicit paths win", () => {
    const config = { aliases: { "https://github.com/Kaltorre/Agentroad": "https://github.com/KNODEdev/Agentroad" },
      paths: { "https://github.com/KNODEdev/claude-mcp-plugins": "H:\\repos\\plugins\\" } };
    expect(cloudPlaces([source("https://github.com/Kaltorre/Agentroad"), source("https://github.com/KNODEdev/claude-mcp-plugins"),
      { type: "other", url: "x" }], clones, config).map(place => place.local))
      .toEqual(["H:/repos/products/Agentroad", "H:/repos/plugins"]);
  });
});

describe("localRepositories", () => {
  test("reads remotes of literal rule directories, including a worktree's common config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-cloud-places-"));
    roots.push(root);
    const main = path.join(root, "TactShift"), worktree = path.join(root, "TactShift-feature");
    fs.mkdirSync(path.join(main, ".git", "worktrees", "feature"), { recursive: true });
    fs.writeFileSync(path.join(main, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/KNODEdev/TactShift.git\n');
    fs.writeFileSync(path.join(main, ".git", "worktrees", "feature", "commondir"), "../..\n");
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "feature")}\n`);
    expect(gitRemoteUrls(worktree)).toEqual(["https://github.com/KNODEdev/TactShift.git"]);
    const clones = localRepositories({ projects: [{ id: "tactshift", name: "TactShift", matches: [
      { cwd: main }, { cwd: worktree }, { cwd: `${root}/*` }, { repo: "x" }] }] });
    expect(clones.get("github.com/knodedev/tactshift")).toEqual([main, worktree].map(dir => dir.replace(/\\/g, "/")));
  });
});
