export type IdentityKind = "email" | "key-fingerprint" | "profile";

export interface AccountIdentity {
  identity_kind: IdentityKind;
  identity: string;

  raw_source: string | null;
}

export interface IdentityRead {
  identity: AccountIdentity | null;
  error: string | null;
}

/**
 * Payload-only decode of a JWT: the signature is never verified, because the
 * token is read from a local credentials file we already trust as much as the
 * disk it sits on. Used only to learn which account is logged in.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = String(token || "").split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
