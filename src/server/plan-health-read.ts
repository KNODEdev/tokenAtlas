import type { Database } from "bun:sqlite";

type PathEvidence = { path: string; tot: number; sp: number };

export function readSparkClassifier(sqlite: Database, memberships: Iterable<ReadonlySet<string>>) {
  const paths = new Set<string>();
  for (const membership of memberships) for (const path of membership) paths.add(path);
  const evidence = new Map<string, PathEvidence>();
  if (paths.size > 0) {
    // One bind avoids SQLite's variable limit. Keep LIKE and cross-home membership in SQL.
    const rows = sqlite.query(`SELECT path,count(*) AS tot,sum(CASE WHEN model LIKE '%spark%' THEN 1 ELSE 0 END) AS sp
      FROM events WHERE path IN (SELECT value FROM json_each(?)) GROUP BY path`).all(JSON.stringify([...paths])) as PathEvidence[];
    for (const row of rows) evidence.set(row.path, row);
  }
  return (membership: ReadonlySet<string>): boolean => {
    let total = 0;
    let spark = 0;
    for (const path of membership) {
      const row = evidence.get(path);
      if (row) { total += row.tot; spark += row.sp; }
    }
    return total > 0 && spark / total > 0.5;
  };
}
