import { CYCLE_READ_BATCH_MAX, type CycleReadBatch } from "../shared/cycle-read-batch";

/** Read-only transport: canonical single URLs remain the dependency and publication identities. */
export async function serveCycleReadBatch(req: Request,
  read: (urls: readonly URL[], signal: AbortSignal) => Promise<Response[]>): Promise<Response> {
  if (req.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const url = new URL(req.url), raw = url.searchParams.get("requests") ?? "";
  let paths: unknown;
  try { paths = JSON.parse(raw); } catch { paths = null; }
  if (raw.length > 16384 || !Array.isArray(paths) || !paths.length || paths.length > CYCLE_READ_BATCH_MAX
    || paths.some(path => typeof path !== "string" || path.length > 4096 || !path.startsWith("/api/cycle-breakdown?")))
    return Response.json({ error: "Invalid cycle batch" }, { status: 400 });
  const urls = (paths as string[]).map(path => new URL(path, url.origin));
  if (urls.some(item => item.origin !== url.origin || item.pathname !== "/api/cycle-breakdown" || item.hash))
    return Response.json({ error: "Invalid cycle batch" }, { status: 400 });
  if (req.signal.aborted) return new Response(null, { status: 499 });
  const responses = await read(urls, req.signal);
  const envelopes = await Promise.all(responses.map(async response => ({
    status: response.status, headers: [...response.headers] as Array<[string, string]>, body: await response.text(),
  })));
  return Response.json({ responses: envelopes } satisfies CycleReadBatch, { headers: { "Cache-Control": "no-store" } });
}
