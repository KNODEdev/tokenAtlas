-- Remembered Claude sign-in identities (`rememberedVendorAccounts`) are read on the main thread
-- before every Claude, Grok and Gemini live reading: `SELECT DISTINCT account_key FROM claude_events
-- WHERE account_key IS NOT NULL AND COALESCE(subscription_conflict,0)=0`. Without an index this
-- read every event row: 0.34 s warm and 5-6 s cold on a 308k-row table, stalling all requests.
-- The partial index holds only the rows that query can return; measured on a copy: 12 ms.
CREATE INDEX IF NOT EXISTS claude_events_remembered_identity ON claude_events(account_key)
  WHERE account_key IS NOT NULL AND COALESCE(subscription_conflict,0)=0;
