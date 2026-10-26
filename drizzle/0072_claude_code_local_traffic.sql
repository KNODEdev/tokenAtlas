-- Claude Code product rule @3 (user decision 09.10.2026): every locally recorded Claude call is Claude Code, whatever
-- launched it (CLI, desktop app, Agent SDKs, MCP). Rule @2 counted only `entrypoint='cli'`, so weeks run from the
-- desktop app had no Code share. Only the stored class changes: no source is read again and nothing is revalued.
-- The window sums producer re-sums the Claude windows once it sees the new rule (window_usage_claude_product).
UPDATE usage_ledger_facts SET product='code_cli' WHERE provider='claude' AND product IS NOT NULL AND product<>'code_cli';
--> statement-breakpoint
UPDATE usage_ledger_facts SET m_product='code_cli' WHERE provider='claude' AND m_product IS NOT NULL AND m_product<>'code_cli';
