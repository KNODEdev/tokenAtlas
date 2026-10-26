import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { createAnalysisSourceRevisions } from "../db/analysis-source-revisions.fixture";
import { dataVersion } from "./data-version";
import { ResponseCache } from "./cache";
import { DATA_VIEWS } from "./data-views";

test("TTFT publications refresh speed without invalidating unrelated prepared answers or response caches", () => {
  const db = new Database(":memory:");
  try {
    createAnalysisSourceRevisions(db);
    db.exec("CREATE TABLE response_time_state(provider TEXT PRIMARY KEY, version INTEGER, revision INTEGER); INSERT INTO response_time_state VALUES ('codex',1,1)");
    const version = (route: string) => dataVersion(db, { firstTokenTimes: DATA_VIEWS[route]?.sources.includes("response_time_hours") });
    const speed = version("/api/model-speed"), timeline = version("/api/codex-timeline-markers"), projects = version("/api/projects");
    const cache = new ResponseCache(), cached = cache.stamp(db), clocked = cache.clockStamp(db, 0);
    cache.set("projects", cached, "kept");
    db.exec("UPDATE response_time_state SET revision=revision+1; INSERT INTO analysis_source_revisions(source,bucket,revision) VALUES ('response_time_hours','*',1)");
    expect(version("/api/model-speed")).not.toBe(speed);
    expect(version("/api/codex-timeline-markers")).toBe(timeline);
    expect(version("/api/projects")).toBe(projects);
    expect(cache.get("projects", cache.stamp(db))).toBe("kept");
    expect(cache.clockStamp(db, 0)).toBe(clocked);
  } finally { db.close(); }
});
