-- Golden rules §9: a published register stays readable while newer facts are processed. The usage
-- ledger records the revision it was last complete at; a ledger complete today is published at its
-- current revision, one still on its first build stays at 0 ("preparing").
ALTER TABLE usage_ledger_state ADD COLUMN published_revision INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE usage_ledger_state SET published_revision=revision WHERE status='ready';
