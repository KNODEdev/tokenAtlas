import { expect, test } from "bun:test";
import { publicCompare, publicProjects } from "./howto-home";

test("projects are ranked and anonymous: no name, path or id reaches the output", () => {
  const subject = (name: string, usd: number, kind = "project") => ({ subject: name, kind, api_usd: usd });
  const result = publicProjects(
    { subjects: [subject("C:/Users/PRIVATE/secret-repo", 5), subject("client-acme", 1), subject("other", 2)] },
    { subjects: [subject("C:/Users/PRIVATE/secret-repo", 40), subject("client-acme", 10), subject("other", 25), subject("small", 5), subject("repo-row", 999, "repo")] });
  expect(result.top).toEqual([{ rank: 1, week: 5, month: 40 }, { rank: 2, week: 2, month: 25 }, { rank: 3, week: 1, month: 10 }]);
  expect(result.projectCount).toBe(4);
  expect(result.topShareOfMonth).toBe(93.8);
  const text = JSON.stringify(result);
  for (const sentinel of ["PRIVATE", "secret", "acme", "other", "repo"]) expect(text).not.toContain(sentinel);
});

test("the compare instrument is null, not zero, when the account has no current weekly window", () => {
  expect(publicCompare({ account: "x", provider: "codex", source: "probe", windows: [] } as never, Date.now(), "A")).toBeNull();
});
