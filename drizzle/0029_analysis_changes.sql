CREATE TABLE IF NOT EXISTS analysis_change_context(id INTEGER PRIMARY KEY CHECK(id=1),origin TEXT);
INSERT OR IGNORE INTO analysis_change_context(id,origin) VALUES(1,NULL);
CREATE TABLE IF NOT EXISTS analysis_changes(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('insert','update','delete')),
  origin TEXT,
  before_json TEXT,
  after_json TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS analysis_changes_source_sequence ON analysis_changes(source,sequence);
