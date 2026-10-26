import type { CSSProperties } from "react";
import { useI18n } from "../lib/i18n";
import { claudeConnectable, claudeConnectState, startClaudeLogin, useClaudeLogins } from "../lib/claude-login";
import type { ProbeErrorCode } from "../../shared/probe-error";
import { GhostButton } from "./ui";

/**
 * "Connect Claude" next to a sign-in notice of this computer: starts the official Claude Code sign-in, so the user
 * signs in once in the browser. Nothing for another computer's notice, another vendor or another failure.
 * `reasonClassName`/`reasonStyle` are the line's own text style, used for a failure's short reason.
 */
export function ClaudeConnect({ issue, reasonClassName, reasonStyle }: {
  issue: { provider: string; subject: string; machine: string | null; code: ProbeErrorCode };
  reasonClassName?: string;
  reasonStyle?: CSSProperties;
}) {
  const { t } = useI18n();
  const logins = useClaudeLogins();
  if (!claudeConnectable(issue, logins?.machine)) return null;
  const state = claudeConnectState(issue.subject, logins);
  return (
    <span data-claude-connect style={{ display: "contents" }}>
      <GhostButton disabled={state.running} onClick={() => { void startClaudeLogin(issue.subject); }}>
        {state.running ? t("Waiting for the browser…", "Czekam na przeglądarkę…") : t("Connect Claude", "Połącz Claude")}
      </GhostButton>
      {state.failure && <span className={reasonClassName} style={reasonStyle}>{state.failure}</span>}
    </span>
  );
}
