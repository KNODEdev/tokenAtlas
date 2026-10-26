import { useEffect, useSyncExternalStore } from "react";
import { ApiError, api, refreshLiveApiData } from "./api";
import { translate } from "./i18n";
import { CLAUDE_CONNECT_CODES, type ClaudeLoginResponse, type ClaudeLoginView } from "../../shared/claude-login";
import type { ProbeErrorCode } from "../../shared/probe-error";

let latest: ClaudeLoginResponse | null = null;
/** Refusals of a start, per subscription (the server keeps no state for a sign-in that never started). */
let refusals: Record<string, string> = {};
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => version;
const notify = () => { version++; for (const listener of listeners) listener(); };

/** The last state read; tests seed it here. */
export function setClaudeLogins(value: ClaudeLoginResponse | null): void {
  latest = value;
  notify();
}

let subscribers = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
// While a sign-in waits for the browser its state is asked for often; otherwise once per mount.
const RUNNING_POLL_MS = 1_500;
function schedule(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (subscribers > 0 && latest?.logins.some(login => login.state === "running")) timer = setTimeout(() => { void refresh(); }, RUNNING_POLL_MS);
}
async function refresh(): Promise<void> {
  try {
    const before = latest;
    const next = await api.claudeLogins();
    const landed = next.logins.some(login => login.state === "succeeded"
      && before?.logins.some(old => old.profile === login.profile && old.started_at === login.started_at && old.state === "running"));
    setClaudeLogins(next);
    // The server reads the limits at once; the notices follow with the other live data.
    if (landed) refreshLiveApiData();
  } catch { /* the next mount or start asks again */ }
  schedule();
}

/** This computer's name and its Claude Code sign-ins; null until first read. */
export function useClaudeLogins(): ClaudeLoginResponse | null {
  useEffect(() => {
    if (++subscribers === 1) void refresh();
    return () => { if (--subscribers === 0 && timer) { clearTimeout(timer); timer = null; } };
  }, []);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return latest;
}

/** Starts the sign-in; a refusal is kept as that subscription's short reason. */
export async function startClaudeLogin(subject: string): Promise<void> {
  delete refusals[subject.toLowerCase()];
  try {
    const { login } = await api.claudeLoginStart(subject);
    const others = latest?.logins.filter(old => old.profile !== login.profile) ?? [];
    setClaudeLogins({ machine: latest?.machine ?? "", logins: [...others, login] });
  } catch (error) {
    refusals = { ...refusals, [subject.toLowerCase()]: refusalText(error) };
    notify();
  }
  schedule();
}

function refusalText(error: unknown): string {
  const reason = error instanceof ApiError ? error.reason : undefined;
  if (reason === "binary-missing") return translate("Claude Code not found on this computer", "nie znaleziono Claude Code na tym komputerze");
  if (reason === "running") return translate("a sign-in is already running", "logowanie już trwa");
  if (reason === "unknown-subject" || reason === "not-local" || reason === "no-discovery")
    return translate("no Claude Code profile of this subscription here", "brak profilu Claude Code tej subskrypcji na tym komputerze");
  return error instanceof Error ? error.message : String(error);
}

/** Whether a notice can be fixed by signing in here: Claude, a sign-in code, and this very computer. */
export function claudeConnectable(issue: { provider: string; code: ProbeErrorCode; machine: string | null }, machine: string | null | undefined): boolean {
  return ["claude", "anthropic"].includes(issue.provider.toLowerCase()) && CLAUDE_CONNECT_CODES.includes(issue.code)
    && !!machine && !!issue.machine && issue.machine.toLowerCase() === machine.toLowerCase();
}

/** What the control next to a notice shows for one subscription. */
export interface ClaudeConnectState { running: boolean; failure: string | null }
export function claudeConnectState(subject: string, response: ClaudeLoginResponse | null = latest): ClaudeConnectState {
  const id = subject.toLowerCase();
  const login = response?.logins.filter(view => view.subject.toLowerCase() === id)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
  const refusal = refusals[id] ?? null;
  if (!login) return { running: false, failure: refusal };
  return {
    running: login.state === "running",
    failure: refusal ?? (login.state === "failed" ? loginFailureText(login) : null),
  };
}

export function loginFailureText(login: Pick<ClaudeLoginView, "reason">): string {
  switch (login.reason) {
    case "timeout": return translate("sign-in timed out", "logowanie przekroczyło czas");
    case "spawn": return translate("Claude Code could not start", "nie udało się uruchomić Claude Code");
    case "no-credentials": return translate("no sign-in was saved", "logowanie nie zostało zapisane");
    case "stopped": return translate("stopped with the server", "przerwane wraz z serwerem");
    default: return translate("sign-in did not finish", "logowanie nie zostało dokończone");
  }
}

/** Tests: forgets refusals and the poll. */
export function resetClaudeLogins(): void {
  refusals = {};
  if (timer) { clearTimeout(timer); timer = null; }
  setClaudeLogins(null);
}
