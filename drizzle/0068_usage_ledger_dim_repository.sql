-- Repository and repository group in the usage ledger's dimension key (docs/stored-activity-plan-2026-10-07.md, the part
-- of M2 pulled forward for step 5): readers of the stored day rows need each row's repository and group. Today every
-- dimension's facts carry exactly one (repo, repo_group) - the working directory is already part of the key - so the
-- re-key is a relabelling: the same rows keep their ids, only the dimension gains the two fields and its key their
-- values. A dimension whose facts carry more than one would need its rows regrouped (full M2, step 7): the guard below
-- stops the migration instead of guessing (CHECK constraint failed: dims_with_several_repositories = 0).
CREATE TEMP TABLE migration_0068_guard(dims_with_several_repositories INTEGER NOT NULL CHECK(dims_with_several_repositories = 0));
--> statement-breakpoint
INSERT INTO temp.migration_0068_guard SELECT COUNT(*) FROM (SELECT provider, dim_id FROM usage_ledger_facts WHERE dim_id IS NOT NULL
  GROUP BY provider, dim_id HAVING COUNT(DISTINCT json_array(repo, repo_group)) > 1);
--> statement-breakpoint
DROP TABLE temp.migration_0068_guard;
--> statement-breakpoint
ALTER TABLE usage_ledger_dims ADD COLUMN repo TEXT;
--> statement-breakpoint
ALTER TABLE usage_ledger_dims ADD COLUMN repo_group TEXT;
--> statement-breakpoint
UPDATE usage_ledger_dims AS m SET repo=f.repo, repo_group=f.repo_group
  FROM (SELECT provider, dim_id, MIN(repo) repo, MIN(repo_group) repo_group FROM usage_ledger_facts WHERE dim_id IS NOT NULL
    GROUP BY provider, dim_id) f
  WHERE m.provider=f.provider AND m.id=f.dim_id;
--> statement-breakpoint
-- The key the producer now writes: json_array(source, account key, model, speed, subject, vendor, home, project,
-- project name, cwd, repo, repo_group). Shared-ledger dimensions only; Codex keeps its own table.
UPDATE usage_ledger_dims SET key=json_insert(key, '$[#]', repo, '$[#]', repo_group);
