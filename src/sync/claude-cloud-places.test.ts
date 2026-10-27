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
    expect(repositoryKey("https://github.com/example-org/SampleApp")).toBe("github.com/example-org/sampleapp");
    expect(repositoryKey("https://github.com/example-org/SampleApp.git")).toBe("github.com/example-org/sampleapp");
    expect(repositoryKey("git@github.com:example-org/SampleApp.git")).toBe("github.com/example-org/sampleapp");
    expect(repositoryKey("not a url")).toBeNull();
  });
});

describe("cloudPlaces", () => {
  const clones = new Map([
    ["github.com/example-org/sampleapp", ["C:/example/repos/products/SampleApp-feature", "C:/example/repos/products/SampleApp"]],
    ["github.com/example-org/secondapp", ["C:/example/repos/products/SecondApp"]],
  ]);
  test("maps the container checkout to the clone named like the repository", () => {
    expect(cloudPlaces([source("https://github.com/example-org/SampleApp")], clones)).toEqual([
      { repository: "https://github.com/example-org/SampleApp", remote: "/home/user/SampleApp", local: "C:/example/repos/products/SampleApp" }]);
  });
  test("owners differ only in case still need the exact URL; unknown repositories stay unresolved", () => {
    expect(cloudPlaces([source("https://github.com/legacy-org/EXAMPLE-TOOLS"), source("https://github.com/example-org/example-tools")], clones)
      .map(place => [place.remote, place.local])).toEqual([["/home/user/EXAMPLE-TOOLS", null], ["/home/user/example-tools", null]]);
  });
  test("aliases follow a repository moved between owners; explicit paths win", () => {
    const config = { aliases: { "https://github.com/legacy-org/SecondApp": "https://github.com/example-org/SecondApp" },
      paths: { "https://github.com/example-org/example-plugin": "C:\\example\\repos\\plugins\\" } };
    expect(cloudPlaces([source("https://github.com/legacy-org/SecondApp"), source("https://github.com/example-org/example-plugin"),
      { type: "other", url: "x" }], clones, config).map(place => place.local))
      .toEqual(["C:/example/repos/products/SecondApp", "C:/example/repos/plugins"]);
  });
});

describe("localRepositories", () => {
  test("reads remotes of literal rule directories, including a worktree's common config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-cloud-places-"));
    roots.push(root);
    const main = path.join(root, "SampleApp"), worktree = path.join(root, "SampleApp-feature");
    fs.mkdirSync(path.join(main, ".git", "worktrees", "feature"), { recursive: true });
    fs.writeFileSync(path.join(main, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/example-org/SampleApp.git\n');
    fs.writeFileSync(path.join(main, ".git", "worktrees", "feature", "commondir"), "../..\n");
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "feature")}\n`);
    expect(gitRemoteUrls(worktree)).toEqual(["https://github.com/example-org/SampleApp.git"]);
    const clones = localRepositories({ projects: [{ id: "sampleapp", name: "SampleApp", matches: [
      { cwd: main }, { cwd: worktree }, { cwd: `${root}/*` }, { repo: "x" }] }] });
    expect(clones.get("github.com/example-org/sampleapp")).toEqual([main, worktree].map(dir => dir.replace(/\\/g, "/")));
  });
});
