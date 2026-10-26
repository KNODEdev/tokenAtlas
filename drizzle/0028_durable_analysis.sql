CREATE TABLE analysis_source_revisions (
  source TEXT NOT NULL,
  bucket TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (source, bucket)
);
--> statement-breakpoint
CREATE TABLE analysis_results (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  stamp TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, key)
);
--> statement-breakpoint
CREATE TABLE analysis_attribution_dirty (
  home TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (home, path)
);
--> statement-breakpoint
CREATE TABLE analysis_requests (
  key TEXT PRIMARY KEY NOT NULL,
  request_json TEXT NOT NULL,
  used_at INTEGER NOT NULL
);
