import type { Database } from "./sqlite";

export const MODEL_SPEED_QUEUE_TRACKING_SCHEMA = `
CREATE INDEX model_speed_queue_work ON model_speed_queue(provider,priority,queued_at,event_id);
CREATE TABLE model_speed_queue_counts(provider TEXT PRIMARY KEY,pending INTEGER NOT NULL CHECK(pending>=0),
  served INTEGER NOT NULL DEFAULT 0,processed INTEGER NOT NULL DEFAULT 0);
CREATE TRIGGER model_speed_queue_added AFTER INSERT ON model_speed_queue BEGIN
  INSERT INTO model_speed_queue_counts(provider,pending) VALUES(NEW.provider,1)
    ON CONFLICT(provider) DO UPDATE SET pending=pending+1;
END;
CREATE TRIGGER model_speed_queue_removed AFTER DELETE ON model_speed_queue BEGIN
  UPDATE model_speed_queue_counts SET pending=pending-1 WHERE provider=OLD.provider;
END;
`;

export const timingQueueClock = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
export const promoteTimingWork = `ON CONFLICT(provider,event_id) DO UPDATE SET
  queued_at=CASE WHEN priority=0 THEN excluded.queued_at ELSE queued_at END,priority=1`;

export function modelSpeedQueueRemaining(db: Database): number {
  return (db.query("SELECT COALESCE(SUM(pending),0) n FROM model_speed_queue_counts").get() as { n: number }).n;
}

/** Each provider gets a slot before another gets its next; urgent FIFO work shares time with backfill. */
export function modelSpeedQueueBatch(db: Database, limit: number): { provider: string; event_id: number }[] {
  const providers = db.query("SELECT provider,processed FROM model_speed_queue_counts WHERE pending>0 ORDER BY served,provider").all() as { provider: string; processed: number }[];
  const share = Math.max(1, Math.ceil(limit / Math.max(1, providers.length)));
  const read = db.query("SELECT provider,event_id FROM model_speed_queue WHERE provider=? AND priority=? ORDER BY queued_at,event_id LIMIT ?");
  const lanes = providers.map(({ provider, processed }) => ({ phase: processed,
    recent: read.all(provider, 1, share) as { provider: string; event_id: number }[],
    history: read.all(provider, 0, share) as { provider: string; event_id: number }[],
  }));
  const result: { provider: string; event_id: number }[] = [];
  while (result.length < limit) {
    let found = false;
    for (const lane of lanes) {
      const item = lane.phase++ % 4 === 3 ? lane.history.shift() ?? lane.recent.shift() : lane.recent.shift() ?? lane.history.shift();
      if (item) { result.push(item); found = true; }
      if (result.length === limit) break;
    }
    if (!found) break;
  }
  return result;
}

export function recordModelSpeedService(db: Database, processed: ReadonlyMap<string, number>): void {
  for (const [provider, count] of processed) db.query(`UPDATE model_speed_queue_counts
    SET served=(SELECT COALESCE(MAX(served),0)+1 FROM model_speed_queue_counts),processed=processed+? WHERE provider=?`).run(count, provider);
}
