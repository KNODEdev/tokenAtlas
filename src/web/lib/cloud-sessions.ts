import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudSessionsResponse } from "../../shared/cloud-sessions";
import { api } from "./api";
import { probeErrorCode } from "../../shared/probe-error";

// A profile never signed in to Claude Code has no cloud history to miss: it needs a sign-in, not a repair.
const signInOnly = (error: string) => probeErrorCode(error) === "login-missing";
const profileName = (archiveDir: string) => archiveDir.split(/[\\/]/).pop();

export function cloudSessionProblems(state: CloudSessionsResponse | null | undefined): string[] {
  if (!state || state.setting.minutes === 0) return [];
  return [...(state.status?.error && !signInOnly(state.status.error) ? [state.status.error] : []),
    ...(state.status?.last?.profiles.flatMap(profile => profile.errors.filter(error => !signInOnly(error))
      .map(error => `${profileName(profile.archiveDir)}: ${error}`)) ?? [])];
}

/** Profiles whose cloud history starts once Claude Code is signed in there. */
export function cloudSessionSignIns(state: CloudSessionsResponse | null | undefined): string[] {
  if (!state || state.setting.minutes === 0) return [];
  return state.status?.last?.profiles.filter(profile => profile.errors.some(signInOnly)).map(profile => profileName(profile.archiveDir)!) ?? [];
}

/** Cloud imports finish independently of the ordinary synchronization cycle. */
export function useCloudSessions() {
  const [state, setState] = useState<{ data: CloudSessionsResponse | null; error: string | null }>({ data: null, error: null });
  const revision = useRef(0);
  const reload = useCallback(async () => {
    const current = ++revision.current;
    try {
      const data = await api.cloudSessions();
      if (revision.current === current) setState({ data, error: null });
    } catch (error) {
      if (revision.current === current) setState(previous => ({ ...previous, error: error instanceof Error ? error.message : String(error) }));
    }
  }, []);
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 30_000);
    return () => { clearInterval(timer); revision.current++; };
  }, [reload]);
  return { ...state, reload };
}
