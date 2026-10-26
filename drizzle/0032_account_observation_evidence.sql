-- Historical rows remain NULL: current credentials cannot establish their origin.
ALTER TABLE account_observations ADD COLUMN source_evidence TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX account_observations_evidence_id ON account_observations(json_extract(source_evidence,'$.observation_id')) WHERE source_evidence IS NOT NULL;
