import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "../../src/db/sqlite";
import { activeDatabasePath } from "../../src/db";
import { withReadSnapshotAsync } from "../../src/db/analysis";
import { loadProjects } from "../../src/projects/remap";
import { handleProjectCost, handleRepoHistory } from "../../src/server/api-projects";
import type { ProjectCostResponse } from "../../src/server/project-cost";
import type { RepoHistory } from "../../src/server/repo-history";
import { readonlyContext } from "./export-howto-snapshot";
import { publicBuildPeriod, publicDrawerSummary, type BuildPeriod } from "./tokenatlas-build";

export async function exportTokenAtlasBuild(output: string, now = Date.now()) {
  const project = loadProjects().projects.find(item => item.id === "tokenatlas" && item.name === "tokenAtlas");
  if (!project) throw new Error("The owner-selected tokenAtlas project is not configured");
  const dbPath = activeDatabasePath(), db = new Database(dbPath, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout=3000");
    const data = await withReadSnapshotAsync(db, async () => {
      const ctx = readonlyContext(db, dbPath), until = new Date(now).toISOString().slice(0, 10);
      const periods = {} as Record<"week" | "month" | "all", BuildPeriod>;
      for (const [key, days] of [["week", 7], ["month", 30], ["all", null]] as const) {
        // Inclusive UTC calendar days, including the current partial day.
        const since = days === null ? null : new Date(Date.parse(`${until}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
        const url = new URL("http://local/api/repo-history");
        url.searchParams.set("project", project.id); url.searchParams.set("by", "model");
        url.searchParams.set("granularity", "day"); url.searchParams.set("idle_gap", "15");
        url.searchParams.set("until", until);
        if (since) url.searchParams.set("since", since);
        const response = await handleRepoHistory(ctx, url);
        if (!response.ok) throw new Error(`Project history unavailable (${response.status})`);
        periods[key] = publicBuildPeriod(await response.json() as RepoHistory, project.id, until);
      }
      // The project drawer's all-time figures come from the same cost report the app shows.
      const costResponse = handleProjectCost(ctx, new URL("http://local/api/project-cost"));
      if (!costResponse.ok) throw new Error(`Project cost unavailable (${costResponse.status})`);
      const drawer = publicDrawerSummary(await costResponse.json() as ProjectCostResponse, project.id, periods.all);
      return {
        version: 1 as const, project: "tokenAtlas" as const, generatedAt: new Date(now).toISOString(),
        method: { source: "repo-history", dayBasis: "UTC", modelShare: "tokens", idleGapMinutes: 15,
          allocation: "Shared project history: dated subscription plan costs allocated by API-value usage; not invoice evidence.",
          scope: "Recorded history assigned to the configured tokenAtlas project; not a claim of complete development history." },
        periods, drawer,
      };
    });
    const changes = db.query("SELECT total_changes() AS n").get() as { n: number };
    if (changes.n !== 0) throw new Error("Readonly export changed the register");
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output + ".stage", JSON.stringify(data, null, 2) + "\n");
    renameSync(output + ".stage", output);
    console.log(JSON.stringify({ generatedAt: data.generatedAt, periods: Object.fromEntries(Object.entries(data.periods).map(([key, period]) => [key, {
      since: period.since, until: period.until, apiUsd: period.apiUsd, allocatedUsd: period.allocatedUsd,
      allocatedComplete: period.allocatedComplete, apiComplete: period.apiComplete, calls: period.calls, models: period.models.length,
    }])), drawer: { paidUsd: data.drawer.paidUsd, apiUsd: data.drawer.apiUsd, subscriptions: data.drawer.subscriptions.length }, writes: 0 }));
    return data;
  } finally { db.close(); }
}

if (import.meta.main) {
  process.env.TZ = "UTC";
  const index = process.argv.indexOf("--output"), argument = index < 0 ? null : process.argv[index + 1];
  if (index >= 0 && (!argument || argument.startsWith("--"))) throw new Error("--output requires a JSON file");
  await exportTokenAtlasBuild(argument ? resolve(argument) : resolve(import.meta.dir, "../../../tokenAtlas-landing/config/tokenatlas-build.json"));
}
