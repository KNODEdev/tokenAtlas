import { loopbackOrigin } from "./claude-login";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Reject foreign authorities before reads too: a loopback listener alone does not prevent DNS rebinding. */
export function refuseForeignHost(req: Request): Response | null {
  const host = req.headers.get("host");
  if (loopbackOrigin(req.url) && (host === null || /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host))) return null;
  return Response.json({ error: "Only loopback hosts are accepted" }, { status: 403 });
}

/**
 * Refuses a write another web page could send to this loopback server. A form or `text/plain` fetch needs no CORS
 * preflight, while `application/json` does and the server answers none; a present Origin must also be loopback
 * (the Vite proxy uses another port). Returns null for reads and for the app's own JSON writes.
 */
export function refuseCrossSiteWrite(req: Request): Response | null {
  if (READ_METHODS.has(req.method)) return null;
  const json = (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
  const origin = req.headers.get("origin");
  if (json && (!origin || loopbackOrigin(origin))) return null;
  return Response.json({ error: "Cross-origin request refused" }, { status: 403 });
}
