// Stored Codex value semantics and native result contracts. No source parsing.

// 6: the session header names the parent of a forked thread (`providerForkedFromId`); files read by an older
// parser are read again so the ledger can resolve the parent's calls a fork replays.
// 7: each event's response time (`resp_ms`, event row index 27). Files read by an older parser are read again
// by the ordinary import, which also fills their times (no separate backfill; decision 06.10).
// 8: spawned-thread parent metadata from source.subagent.thread_spawn is retained in nested for project inheritance.
export const CODEX_PARSER_VERSION = 8;
export const MAX_COUNTER = 9007199254740991;
export const FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens",
  "output_tokens", "reasoning_output_tokens", "total_tokens"] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Dict = { [key: string]: Json };
type Value = Json | undefined;

export const isDict = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const has = (value: Dict, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const isNone = (value: Value) => value === undefined || value === null;
/** Python `int` for a JSON value: an integral number (booleans are excluded by `type(n) is int`). */
const isInt = (value: Value): value is number => typeof value === "number" && Number.isInteger(value);
const numeric = (value: Value): number | undefined => typeof value === "number" ? value : typeof value === "boolean" ? Number(value) : undefined;

export function pyEqual(left: Value, right: Value): boolean {
  if (isNone(left) || isNone(right)) return isNone(left) && isNone(right);
  const a = numeric(left), b = numeric(right);
  if (a !== undefined || b !== undefined) return a !== undefined && b !== undefined && a === b;
  if (typeof left === "string" || typeof right === "string") return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => pyEqual(item, right[index]));
  }
  const leftKeys = Object.keys(left as Dict), rightKeys = Object.keys(right as Dict);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => has(right as Dict, key) && pyEqual((left as Dict)[key], (right as Dict)[key]));
}

function pyFloatRepr(value: number, integral: boolean): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  if (integral) return Number.isSafeInteger(value) ? String(value) : BigInt(value).toString();
  // repr(float): shortest round-trip digits, scientific below 1e-4 or from 1e16.
  const [mantissa, exponentText] = value.toExponential().split("e") as [string, string];
  const exponent = Number(exponentText);
  const negative = mantissa.startsWith("-"), digits = mantissa.replace(/^-/, "").replace(".", "");
  let text: string;
  if (exponent < -4 || exponent >= 16) {
    text = digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") + "e" + (exponent < 0 ? "-" : "+")
      + String(Math.abs(exponent)).padStart(2, "0");
  } else if (exponent < 0) text = "0." + "0".repeat(-exponent - 1) + digits;
  else {
    const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0"), fraction = digits.slice(exponent + 1);
    text = whole + "." + (fraction || "0");
  }
  return (negative ? "-" : "") + text;
}

/** `json.dumps(value)` with Python's defaults: ", "/": " separators and ASCII-only escapes. */
export function pyDumps(value: Value): string {
  if (isNone(value)) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return pyFloatRepr(value, Number.isInteger(value));
  if (typeof value === "string") {
    return '"' + value.replace(/[\u0000-\u001f"\\\u007f-￿]/g, char => {
      switch (char) {
        case '"': return '\\"';
        case "\\": return "\\\\";
        case "\n": return "\\n";
        case "\r": return "\\r";
        case "\t": return "\\t";
        case "\b": return "\\b";
        case "\f": return "\\f";
        default: return char === "\u007f" ? char : "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0");
      }
    }) + '"';
  }
  if (Array.isArray(value)) return "[" + value.map(pyDumps).join(", ") + "]";
  return "{" + Object.keys(value).map(key => pyDumps(key) + ": " + pyDumps(value[key])).join(", ") + "}";
}

export function usageMetadata(usage: Dict): [number[], string, string] {
  const validNumber = (n: Value): n is number => isInt(n) && n >= 0 && n <= MAX_COUNTER;
  let status = has(usage, "cache_write_input_tokens") ? "reported" : "missing";
  if (status === "reported" && !validNumber(usage.cache_write_input_tokens)) status = "invalid";
  const values = FIELDS.slice(0, 5).map(name => has(usage, name) ? usage[name] : 0);
  let valid = values.every(validNumber);
  if (valid) {
    const [i, r, w, o, reasoning] = values as number[];
    valid = r! + w! <= i! && reasoning! <= o! && i! + o! <= MAX_COUNTER;
    if (has(usage, "total_tokens")) valid = valid && validNumber(usage.total_tokens) && usage.total_tokens === i! + o!;
  }
  let quality = valid ? "valid" : "invalid";
  if (valid && !["input_tokens", "cached_input_tokens", "output_tokens"].every(name => has(usage, name))) quality = "incomplete";
  return [values.map(n => validNumber(n) ? n : 0), status, quality];
}

export function usageFromColumns(values: Array<number | null>, flags: number | null): Dict {
  const usage: Dict = {};
  FIELDS.forEach((name, index) => {
    if (values[index] !== null || ((flags ?? 0) >> index & 1)) usage[name] = values[index] ?? null;
  });
  return usage;
}

export type CodexEventRow = Value[];
/** ts, window_minutes, used_percent, resets_at, plan_type, limit_id, limit_name, source_offset, source_slot. */
export type CodexRateLimitRow = Value[];

/** Raw JSONL record bytes, including their original newline; contains no provider content. */
export interface CodexRecordEvidence { byteStart: number; byteEnd: number; sha256: string }
export interface CodexEventEvidence {
  sourceOffset: number;
  accountingRecord: CodexRecordEvidence;
  acceptedEventRecord: CodexRecordEvidence;
  providerThreadId: string | null;
  providerSessionId: string | null;
  providerResponseId: string | null;
  providerTurnId: string | null;
  conflictingUsage: boolean;
  duplicateRecords: CodexRecordEvidence[];
}
export interface CodexSessionEvidence extends CodexRecordEvidence {
  sourceOffset: number; providerSessionId: string | null;
  /** `forked_from_id` of this header; absent from results of parsers before version 6. */
  providerForkedFromId?: string | null;
}
export interface CodexSourceEvidence {
  source: { sha256: string; byteLength: number; scope: "complete-lines" | "file-prefix" };
  events: CodexEventEvidence[];
  sessionHeaders: CodexSessionEvidence[];
}

export interface CodexRolloutParse {
  firstToken?: { version: number; turns: import("../providers/first-token/types").FirstTokenTurn[] } | null;
  events: CodexEventRow[];
  rateLimits: CodexRateLimitRow[];
  consumed: number;
  state: Dict;
  evidence: CodexSourceEvidence;
}

export type CodexFilePreparation =
  | { kind: "ok"; parse: CodexRolloutParse }
  | { kind: "read_error"; errno: number | null; message: string; code: string | null };

