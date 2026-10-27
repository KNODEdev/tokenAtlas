import { test, expect } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleCodexTimelineMarkers, type TimelineMarker, type TimelineMarkersResponse } from "./codex-timeline-markers";

test("marker settings persist; whole-archive model discovery, overrides and stale-write protection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-marker-test-"));
  const db = new Database(":memory:");
  db.exec("CREATE TABLE events(model TEXT, ts TEXT); INSERT INTO events VALUES ('gpt-5.6-sol','2026-07-09T00:00:00Z'),('gpt-5.6-sol','2026-08-09T00:00:00Z'),('gpt-6-astra','2026-09-04T00:00:00Z')");
  const get = async () => (await handleCodexTimelineMarkers(db, new Request("http://local/api/codex-timeline-markers"), root)).json() as Promise<TimelineMarkersResponse>;
  const post = (body: unknown) => handleCodexTimelineMarkers(db, new Request("http://local/api/codex-timeline-markers", { method: "POST", body: JSON.stringify(body) }), root);
  try {
    const original = await get();
    expect(original.automatic[0]!.day).toBe("2026-07-09");
    expect(original.automatic[0]!.observed_at).toBe("2026-07-09T00:00:00Z");
    expect(original.automatic.find(m => m.id === "price:gpt-5.6-luna-terra-20260730")).toMatchObject({ day: "2026-07-30", visible: true });
    expect(original.automatic.find(m => m.id === "price:gpt-5.6-sol-api-20260821")).toMatchObject({ day: "2026-08-21", visible: true });
    expect(fs.existsSync(path.join(root, "codex-timeline-markers.json"))).toBe(false);
    const marker: TimelineMarker = { id: "custom:example", day: "2026-08-01", label: "Zmiana trybu", note: "własny opis", color: "warn", visible: true };
    expect((await post({ revision: original.revision, marker })).status).toBe(200);
    const saved = await get(); expect(saved.markers).toEqual([marker]);
    expect((await post({ revision: original.revision, marker: { ...marker, label: "stary zapis" } })).status).toBe(409);
    expect((await get()).markers[0]!.label).toBe(marker.label);
    const override = { ...original.automatic[1]!, day: "2026-09-03", visible: false };
    expect((await post({ revision: saved.revision, marker: override })).status).toBe(200);
    const revised = await get(); expect(revised.markers.find(m => m.id === override.id)).toEqual(override);
    db.exec("INSERT INTO events VALUES ('future-model','2026-09-10T00:00:00Z')");
    expect((await get()).automatic.find(m => m.id === "model:future-model")?.visible).toBe(false);
    db.exec("INSERT INTO events VALUES ('gpt-5.6-luna','2026-07-10T12:00:00Z'),('gpt-5.6-terra','2026-07-11T12:00:00Z')");
    const withUtilityModels = await get();
    for (const model of ["gpt-5.6-luna", "gpt-5.6-terra"]) {
      expect(withUtilityModels.automatic.find(m => m.id === `model:${model}`)?.visible).toBe(true);
    }
    db.exec("INSERT INTO events VALUES ('gpt-6.1-terra','2026-10-26T21:59:22.940Z')");
    expect((await get()).automatic.find(m => m.id === "model:gpt-6.1-terra")).toMatchObject({ day: "2026-10-26", visible: true });
    expect((await post({ revision: revised.revision, marker: { ...marker, day: "2026-02-30" } })).status).toBe(400);
    expect((await post({ revision: revised.revision, marker: { ...marker, id: "../../escape" } })).status).toBe(400);
    expect((await post({ revision: revised.revision, remove: marker.id })).status).toBe(200);
    expect((await get()).markers.some(m => m.id === marker.id)).toBe(false);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
