function diagnosticText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const STACK_FRAME = /^\s*(?:at(?:\s|$).*|File\s+["'].*["'],\s+line\s+\d+.*|Traceback \(most recent call last\):)\s*$/gim;
const WINDOWS_PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\r\n,;|<>"')\]}]+/g;
const POSIX_PATH = /(^|[\s(["'=])\/[^\r\n,;|<>"')\]}]+/gm;

/** Browser diagnostics are intentionally lossy: operational detail must not disclose local paths or stacks. */
export function browserSafeDiagnostic(value: unknown): string {
  const safe = diagnosticText(value)
    .replace(/\\r\\n|\\n|\\r/g, "\n")
    .replace(STACK_FRAME, "")
    .replace(WINDOWS_PATH, "[ścieżka ukryta]")
    .replace(POSIX_PATH, (_match, prefix: string) => `${prefix}[ścieżka ukryta]`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return (safe || "brak szczegółów").slice(0, 600);
}
