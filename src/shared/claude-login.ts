import type { ProbeErrorCode } from "./probe-error";

/** "Connect Claude" (`/api/claude-login`): the official Claude Code sign-in started for one local profile. */
export type ClaudeLoginStatus = "running" | "succeeded" | "failed";
/** `exit`: the CLI ended without a sign-in; `no-credentials`: it ended well but the profile holds no token. */
export type ClaudeLoginReason = "timeout" | "exit" | "spawn" | "no-credentials" | "stopped";
/** Why a sign-in could not start. */
export type ClaudeLoginRefusalReason = "unknown-subject" | "not-local" | "no-discovery" | "running" | "binary-missing";
/** One profile's sign-in; an idle profile has none. Never carries a token. */
export interface ClaudeLoginView {
  subject: string;
  profile: string;
  state: ClaudeLoginStatus;
  /** The page the CLI printed for a browser that did not open. */
  url: string | null;
  browser_opened: boolean;
  reason: ClaudeLoginReason | null;
  exit_code: number | null;
  /** The CLI's last output line, without URLs or key-like text. */
  detail: string | null;
  started_at: string;
  finished_at: string | null;
}
/** `GET /api/claude-login`: this computer's name (to tell its notices from other computers') and the sign-ins. */
export interface ClaudeLoginResponse { machine: string; logins: ClaudeLoginView[] }

/** The probe failures a new sign-in on that computer cures. */
export const CLAUDE_CONNECT_CODES: readonly ProbeErrorCode[] = ["login-expired", "login-missing", "login-mismatch"];
