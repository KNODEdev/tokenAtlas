/**
 * Read-only client for Claude Code cloud sessions (docs/cloud-sessions-import-2026-10-23.md).
 * The routes are undocumented; their shape was verified on 23.10.2026. Only GET requests are made,
 * and no credential ever appears in a URL, an error or a log line.
 */
export const CLOUD_API_ORIGIN = "https://api.anthropic.com";
const CLOUD_BETA = "ccr-byoc-2025-07-29";
/** The events route rejects larger pages (HTTP 400, "limit ... less than or equal to 500"). */
export const CLOUD_EVENTS_PAGE = 500;
const MAX_PAGES = 10_000;

export interface CloudAuth { token: string; trustedDevice: string | null }
export interface CloudHttpResponse { status: number; text: string }
export type CloudGet = (url: string, headers: Record<string, string>) => Promise<CloudHttpResponse>;

export class CloudApiError extends Error {
  constructor(readonly status: number, readonly route: string, detail: string) {
    super(`Claude cloud ${route}: HTTP ${status}${detail ? ` (${detail})` : ""}`);
    this.name = "CloudApiError";
  }
}

export const defaultCloudGet: CloudGet = async (url, headers) => {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  return { status: response.status, text: await response.text() };
};

/** The provider's own error type and message, never the request. */
function errorDetail(text: string): string {
  try {
    const error = (JSON.parse(text) as { error?: { type?: unknown; message?: unknown; resource?: unknown } }).error;
    return [error?.type, error?.resource, error?.message].filter(v => typeof v === "string" && v).join(": ").slice(0, 300);
  } catch { return ""; }
}

async function getObject(get: CloudGet, auth: CloudAuth, route: string, label: string,
  params: Record<string, string>, needsDevice: boolean): Promise<Record<string, unknown>> {
  if (needsDevice && !auth.trustedDevice) throw new CloudApiError(403, label, "this Claude profile is not a trusted device");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`, "anthropic-version": "2023-06-01", "anthropic-beta": CLOUD_BETA,
  };
  if (needsDevice) headers["X-Trusted-Device-Token"] = auth.trustedDevice!;
  const query = new URLSearchParams(params).toString();
  const response = await get(`${CLOUD_API_ORIGIN}${route}${query ? `?${query}` : ""}`, headers);
  if (response.status !== 200) throw new CloudApiError(response.status, label, errorDetail(response.text));
  let body: unknown;
  try { body = JSON.parse(response.text); } catch { throw new CloudApiError(200, label, "response is not JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray((body as { data?: unknown }).data))
    throw new CloudApiError(200, label, "response has no data list");
  return body as Record<string, unknown>;
}

/** Every session of the account, all pages (`has_more` / `last_id`). */
export async function listCloudSessions(get: CloudGet, auth: CloudAuth): Promise<Array<Record<string, unknown>>> {
  const sessions: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await getObject(get, auth, "/v1/sessions", "sessions", after ? { after_id: after } : {}, false);
    for (const session of body.data as Array<Record<string, unknown>>) {
      if (typeof session?.id !== "string") throw new CloudApiError(200, "sessions", "a session has no id");
      if (!seen.has(session.id)) { seen.add(session.id); sessions.push(session); }
    }
    if (body.has_more !== true) return sessions;
    if (typeof body.last_id !== "string" || body.last_id === after) throw new CloudApiError(200, "sessions", "paging did not advance");
    after = body.last_id;
  }
  throw new CloudApiError(200, "sessions", "too many pages");
}

/**
 * The account that owns the listed sessions: the identity of the token that listed them
 * (`/api/oauth/profile`, as the account probes read it), as a `claude:<account>:<organization>` key.
 */
export async function readCloudOwner(get: CloudGet, auth: CloudAuth): Promise<string> {
  const response = await get(`${CLOUD_API_ORIGIN}/api/oauth/profile`, {
    Authorization: `Bearer ${auth.token}`, "anthropic-beta": "oauth-2025-04-20",
  });
  if (response.status !== 200) throw new CloudApiError(response.status, "profile", errorDetail(response.text));
  let body: { account?: { uuid?: unknown }; organization?: { uuid?: unknown } };
  try { body = JSON.parse(response.text); } catch { throw new CloudApiError(200, "profile", "response is not JSON"); }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const account = body.account?.uuid, organization = body.organization?.uuid;
  if (typeof account !== "string" || typeof organization !== "string" || !uuid.test(account) || !uuid.test(organization))
    throw new CloudApiError(200, "profile", "no account and organization identity");
  return `claude:${account.toLowerCase()}:${organization.toLowerCase()}`;
}

export interface CloudEventRead {
  /** Event envelopes as the provider sent them, in `sequence_num` order. */
  events: Array<Record<string, unknown>>;
  /** Where the next read continues; the same cursor comes back while nothing is new. */
  resumeCursor: string | null;
}

/** Events after `cursor` (from the first event without one), every page (`next_cursor`, then `resume_cursor`). */
export async function readCloudEvents(get: CloudGet, auth: CloudAuth, sessionId: string,
  cursor: string | null): Promise<CloudEventRead> {
  const route = `/v1/code/sessions/${encodeURIComponent(sessionId)}/events`;
  const events: Array<Record<string, unknown>> = [];
  let next = cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = { limit: String(CLOUD_EVENTS_PAGE), sort_order: "asc" };
    if (next) params.cursor = next;
    const body = await getObject(get, auth, route, "events", params, true);
    events.push(...body.data as Array<Record<string, unknown>>);
    if (typeof body.next_cursor === "string" && body.next_cursor) {
      if (body.next_cursor === next) throw new CloudApiError(200, "events", "paging did not advance");
      next = body.next_cursor;
      continue;
    }
    return { events, resumeCursor: typeof body.resume_cursor === "string" && body.resume_cursor ? body.resume_cursor : null };
  }
  throw new CloudApiError(200, "events", "too many pages");
}
