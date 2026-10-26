import {FINAL_CONTEXT_PATHS,finalContextStamp} from "./codex-context-final-read";
import { contextPreviewReader } from "./codex-context-read";
export { contextPreviewReader } from "./codex-context-read";
import type { Database } from "../db/sqlite";
import { captureContextRead, inContextRead, runContextRead } from "../db/codex-context-read-scope";
import { codexContextPending, readCodexContextState } from "../db/codex-context-producer";
import { withReadSnapshot } from "../db/analysis";
import type { ContextPreviewResponse } from "../shared/context-preview";
import { CONTEXT_RESPONSE_PATHS } from "../shared/context-preview";
import { contextDetailPreviewReader, CONTEXT_DETAIL_PATHS } from "./codex-context-detail-read";
import { contextDetailsState, contextWindowRangesPending } from "../db/codex-context-details";
export { CONTEXT_RESPONSE_PATHS } from "../shared/context-preview";

export function contextRequested(url: URL): boolean {
  return CONTEXT_RESPONSE_PATHS.has(url.pathname) && url.searchParams.get("context") === "1";
}
export function contextProjectionStamp(db: Database, url?: URL): string {
  const state = readCodexContextState(db);
  return JSON.stringify(["context-response-1", state && [state.version, state.revision, state.source_revision, state.covered_revision,
    state.filled, state.generation, codexContextPending(db, state)],
    ...(url&&FINAL_CONTEXT_PATHS.has(url.pathname)?[finalContextStamp(db,url.pathname)]:[]),
    ...(url && CONTEXT_DETAIL_PATHS.has(url.pathname) ? [contextDetailsState(db),contextWindowRangesPending(db),
      !!contextDetailsState(db) && !!db.query("SELECT 1 FROM codex_context_model_pending LIMIT 1").get()] : [])]);
}
/** Run the same report fold on paired saved measures. Existing monetary fields always remain the first result. */
export function withContextPreview<T extends object>(db: Database, read: () => T, requested = false): T & ContextPreviewResponse<T> {
  if (inContextRead(db)) return read();
  if (!requested) return withReadSnapshot(db, read);
  return withReadSnapshot(db, () => {
    const reader = contextPreviewReader(db), base = reader.status.ready ? captureContextRead(reader.scope, read) : read();
    if (!reader.status.ready) return { ...base, context_preview_status: reader.status };
    const preview = runContextRead(reader.scope, read);
    return { ...base, context_preview: preview, context_preview_status: reader.status };
  });
}
export type JsonResponse = (body: unknown, init?: ResponseInit) => Response;
/** Keeps synchronous handlers synchronous and avoids parsing or serializing either intermediate report. */
export function contextPreviewResponse(db: Database, read: (json: JsonResponse) => Response, requested = false, kind?: "details" | "models"): Response {
  if (!requested || inContextRead(db)) return read(Response.json);
  return withReadSnapshot(db, () => {
    let body: unknown, init: ResponseInit | undefined;
    const json: JsonResponse = (value, options) => { body = value; init = options; return new Response(null, options); };
    const reader = kind ? contextDetailPreviewReader(db, kind) : contextPreviewReader(db);
    const response = reader.status.ready ? captureContextRead(reader.scope, () => read(json)) : read(json);
    if (body === undefined) return response;
    if (response.status !== 200 || body === null || typeof body !== "object") return Response.json(body, init);
    const base = body;
    if (reader.status.ready) {
      runContextRead(reader.scope, () => read(json));
      return Response.json({ ...base, context_preview: body, context_preview_status: reader.status }, init);
    }
    return Response.json({ ...base, context_preview_status: reader.status }, init);
  });
}
