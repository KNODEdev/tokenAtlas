-- Stored window answers (db/window-answers.ts): the answer of a window screen over its scope, kept until a
-- mark overlapping that scope makes it stale. Marks are appended by the writers of window-sum inputs.
CREATE TABLE IF NOT EXISTS window_answers (
  route TEXT NOT NULL, key TEXT NOT NULL, family TEXT NOT NULL,
  provider TEXT NOT NULL, account TEXT NOT NULL, from_ms INTEGER NOT NULL, until_ms INTEGER,
  configuration TEXT NOT NULL, checked INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 0,
  built_at INTEGER NOT NULL, expires_at INTEGER, status INTEGER NOT NULL, version TEXT NOT NULL,
  headers TEXT NOT NULL, body BLOB NOT NULL,
  PRIMARY KEY(route, key)
) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS window_answers_family ON window_answers(route, family, built_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS window_answers_scope ON window_answers(provider, account);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS window_answer_marks (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, account TEXT NOT NULL,
  from_ms INTEGER NOT NULL, until_ms INTEGER, created_ms INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS window_answer_state (
  id INTEGER PRIMARY KEY CHECK(id=1), folded INTEGER NOT NULL
) STRICT;
