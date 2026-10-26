/**
 * Plain names of the recorded launch context (the `surface` of a Codex event, the `entrypoint` of a
 * Claude call). Polish uses one word for the idea, "kontekst", on every screen.
 */
const SURFACE_NAMES: Record<string, { en: string; pl: string }> = {
  "ide-app": { en: "Codex desktop / VS Code", pl: "Codex desktop / VS Code" },
  "ide-app+nested": { en: "Codex desktop with nested tasks", pl: "Codex desktop z zadaniami podrzędnymi" },
  "cli-tui": { en: "Interactive Codex in the terminal", pl: "Interaktywny Codex w terminalu" },
  "cli-tui+nested": { en: "Terminal TUI with nested tasks", pl: "Terminal TUI z zadaniami podrzędnymi" },
  "cli-exec": { en: "Manually run exec / scripts", pl: "Ręcznie uruchamiany exec / skrypty" },
  "cli-exec+nested": { en: "CLI exec with nested tasks", pl: "CLI exec z zadaniami podrzędnymi" },
  "mcp-server": { en: "Codex as an MCP server", pl: "Codex jako serwer MCP" },
  "mcp-server+nested": { en: "MCP server with nested tasks", pl: "Serwer MCP z zadaniami podrzędnymi" },
  "mcp-wrapper": { en: "CLI exec with delegate-ledger", pl: "CLI exec z delegate-ledger" },
  "codex_vscode+nested": { en: "VS Code extension with nested tasks", pl: "Rozszerzenie VS Code z podzadaniami" },
  "claude code+nested": { en: "Claude Code CLI with nested tasks", pl: "Claude Code CLI z podzadaniami" },
  cli: { en: "Claude Code CLI", pl: "Claude Code CLI" },
  "sdk-cli": { en: "Claude SDK", pl: "Claude SDK" },
  cloud: { en: "Claude Code in the cloud", pl: "Claude Code w chmurze" },
};

/** The plain name of a context code, or the code itself when it has none. */
export function surfaceName(code: string, t: (en: string, pl: string) => string): string {
  const name = SURFACE_NAMES[code];
  return name ? t(name.en, name.pl) : code;
}
