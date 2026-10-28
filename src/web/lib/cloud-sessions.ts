import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudSessionsResponse } from "../../shared/cloud-sessions";
import { api } from "./api";

export function cloudSessionProblems(state: CloudSessionsResponse | null | undefined): string[] {
  if (!state || state.setting.minutes === 0) return [];
  return [...(state.status?.error ? [state.status.error] : []),
    ...(state.status?.last?.profiles.flatMap(profile => profile.errors.map(error => `${profile.archiveDir.split(/[\\/]/).pop()}: ${error}`)) ?? [])];
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
