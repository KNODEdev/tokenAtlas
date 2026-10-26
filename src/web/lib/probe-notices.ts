import { useEffect, useSyncExternalStore } from "react";
import type { ProbeNotice } from "../../shared/probe-error";
import { api } from "./api";
import { probeIssueText, type ProbeIssueText } from "./probe";
import { useAsync } from "./useAsync";

let latest: ProbeNotice[] | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => latest;

/** The last notices read; tests seed them here. */
export function setProbeNotices(notices: ProbeNotice[] | null): void {
  if (notices === latest) return;
  latest = notices;
  for (const listener of listeners) listener();
}

/** Accounts whose limit readings stopped for a reason the user fixes (`/api/probe-notices`); null until first read. */
export function useProbeNotices(): ProbeNotice[] | null {
  // Live: a probe cycle that fails or recovers refreshes the notices with the other readings.
  const read = useAsync(async () => api.probeNotices(), [], true).data;
  useEffect(() => { if (read) setProbeNotices(read.notices); }, [read]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** One line per account and computer, in the order the server sorted them. */
export function probeNoticeLines(notices: readonly ProbeNotice[] | null | undefined, nowMs = Date.now()): Array<ProbeIssueText & { key: string }> {
  return (notices ?? []).map(notice => ({ key: `${notice.provider}/${notice.subject}/${notice.machine ?? ""}`,
    ...probeIssueText({ provider: notice.provider, machine: notice.machine, code: notice.code, since: notice.since,
      account: notices!.filter(other => other.provider === notice.provider && other.subject !== notice.subject).length
        ? notice.account ?? notice.subject : null, nowMs }) }));
}
