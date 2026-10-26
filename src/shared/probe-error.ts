/**
 * Structured probe failures the user can fix. A probe error is stored as text (`probe_windows.error`), so the
 * code travels as a leading `[code]` marker in front of an English diagnostic; screens read the code and show
 * their own localized sentence instead of the diagnostic.
 */
/**
 * `login-expired`: the sign-in expired and cannot be refreshed; `login-mismatch`: the profile is signed in to another
 * account; `login-save-failed`: a refreshed sign-in could not be saved to the profile (or was not attempted because
 * it could not be saved safely); `login-missing`: the profile was never signed in (no credentials file), so there is
 * no token to read the limits with.
 */
export const PROBE_ERROR_CODES = ["login-expired", "login-mismatch", "login-save-failed", "login-missing"] as const;
export type ProbeErrorCode = typeof PROBE_ERROR_CODES[number];

const MARKER = /^\[([a-z-]+)\]\s*/;

/** `[login-expired] Claude sign-in expired: …` */
export function codedProbeError(code: ProbeErrorCode, detail: string): string {
  return `[${code}] ${detail}`;
}

/**
 * A Claude profile without `.credentials.json` was never signed in to Claude Code (the desktop app keeps its own
 * sign-in, which is never read). On macOS the CLI keeps the sign-in in the Keychain, so a missing file proves nothing.
 */
export function claudeLoginMissing(file: string,
  platform: string = (globalThis as { process?: { platform?: string } }).process?.platform ?? ""): string {
  return platform === "darwin" ? `no credentials file (${file})`
    : codedProbeError("login-missing", "Claude Code is not signed in in this profile (no .credentials.json); sign in to read the limits.");
}

/** The code of a stored probe error, or null for an uncoded (diagnostic-only) error. */
export function probeErrorCode(error: string | null | undefined): ProbeErrorCode | null {
  const code = error?.match(MARKER)?.[1];
  return code && (PROBE_ERROR_CODES as readonly string[]).includes(code) ? code as ProbeErrorCode : null;
}

/** The diagnostic behind the code marker. */
export function probeErrorDetail(error: string): string {
  return error.replace(MARKER, "");
}

/**
 * `/api/probe-notices`: one entry per account and computer whose newest limit reading failed with a code the
 * user can fix. `since` is the last successful reading on that computer (null: none yet), `failed_at` the
 * newest failure.
 */
export interface ProbeNotice {
  provider: string;
  subject: string;
  /** The account's e-mail or declared label when known, to tell several accounts of one vendor apart. */
  account: string | null;
  machine: string | null;
  code: ProbeErrorCode;
  since: string | null;
  failed_at: string;
}
export interface ProbeNoticesResponse { notices: ProbeNotice[]; preparing?: boolean }
