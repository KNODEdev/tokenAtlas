import { useEffect, useState } from "react";

export interface CurrentResource<T> { data: T; etag: string | null }
export async function readCurrent<T>(url: string, signal: AbortSignal, previous?: CurrentResource<T>, fetcher: typeof fetch = fetch): Promise<CurrentResource<T>> {
  const response = await fetcher(url, {
    signal, headers: previous?.etag ? { "If-None-Match": previous.etag } : undefined,
  });
  if (response.status === 304 && previous) return previous;
  if (!response.ok) throw new Error(`Odczyt stanu niedostępny (${response.status}).`);
  const data = await response.json() as T;
  return { data, etag: response.headers.get("ETag") };
}
/** One sequential polling loop per mounted context. Changing context aborts the old request. */
export function useCurrent<T>(url: string | null) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ url: string | null; data: T | null; error: string | null }>({ url: null, data: null, error: null });
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous: CurrentResource<T> | undefined;
    const poll = async () => {
      try {
        previous = await readCurrent<T>(url, controller.signal, previous);
        if (!controller.signal.aborted) setState({ url, data: previous.data, error: null });
      } catch (error) {
        if (!controller.signal.aborted) setState((old) => ({
          url, data: old.url === url ? old.data : null,
          error: error instanceof Error ? error.message : "Odczyt stanu niedostępny.",
        }));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 10_000);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [url, retry]);
  // Never flash the previous account's quota while the next request is pending.
  return {
    data: url && state.url === url ? state.data : null,
    error: url && state.url === url ? state.error : null,
    reload: () => setRetry((value) => value + 1),
  };
}
export const CURRENT_SELECTION_KEY = "tokenatlas.current-subscription";
export const PORTFOLIO_CONTEXT = "__all__";
export function validCurrentSelection(value: string | null, ids: string[]): string {
  return value && ids.includes(value) ? value : PORTFOLIO_CONTEXT;
}
export function readCurrentSelection(): string {
  try { return localStorage.getItem(CURRENT_SELECTION_KEY) || PORTFOLIO_CONTEXT; } catch { return PORTFOLIO_CONTEXT; }
}
export function saveCurrentSelection(id: string): void {
  try { localStorage.setItem(CURRENT_SELECTION_KEY, id); } catch { /* Private browsing can deny storage. */ }
}
