import { polishPlural } from "../../lib/mixFormat";
import type { UnassignedRow, ProjectMatch } from "../../lib/api";
import type { RosterCard } from "../../lib/roster";

export type Translate = (en: string, pl: string) => string;

export function countLabel(
  t: Translate,
  n: number,
  enOne: string,
  enMany: string,
  plOne: string,
  plFew: string,
  plMany: string,
): string {
  return t(Math.abs(n) === 1 ? enOne : enMany, polishPlural(n, plOne, plFew, plMany));
}

export function rowKey(r: UnassignedRow): string {
  return [r.vendor, r.store, r.cwd ?? "", r.project ?? ""].join("\u0000");
}

export function storePresentation(row: UnassignedRow, cards: RosterCard[], t: Translate): { label: string; title?: string } {
  const names = new Map(cards.map(card => [card.id.toLowerCase(), card.vendorAccount?.trim() || card.id]));
  const ids = [...new Set(row.account_ids ?? [])];
  const labels = [...new Set(ids.map(id => names.get(id.toLowerCase()) ?? id))];
  if (!labels.length) return { label: row.store };
  const label = labels.length === 1
    ? labels[0]!
    : countLabel(t, labels.length, "account", "accounts", "konto", "konta", "kont");
  const title = [...new Set([row.store, ...ids.map(id => {
    const name = names.get(id.toLowerCase()) ?? id;
    return name === id ? id : `${name} · ${id}`;
  })])].join("\n");
  return { label, ...(title === label ? {} : { title }) };
}

export function basename(cwd: string | null, project: string | null): string {
  if (cwd) {
    const parts = cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || cwd;
  }
  return project ?? "?";
}

export function ruleFor(row: UnassignedRow, base: string): ProjectMatch {
  return row.cwd ? { cwd: row.cwd.replace(/\\/g, "/") } : { project: row.project ?? base };
}

const normCwd = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** Client-side mirror of the resolver's plain rules (src/projects/resolve.ts): a path also matches its subdirectories. */
export function catches(rule: ProjectMatch, row: UnassignedRow): boolean {
  if (rule.store && rule.store.toLowerCase() !== row.store.toLowerCase()) return false;
  if (rule.cwd) {
    if (!row.cwd) return false;
    const want = normCwd(rule.cwd);
    const have = normCwd(row.cwd);
    if (have !== want && !have.startsWith(want + "/")) return false;
  }
  if (rule.project && (row.project ?? "").toLowerCase() !== rule.project.toLowerCase()) return false;
  return !!(rule.cwd || rule.project);
}

/** Rows of one directory (every vendor and account) shown as one line; `head` carries their sums. */
export type PathGroup = { key: string; head: UnassignedRow; members: UnassignedRow[] };

export function groupByPath(rows: UnassignedRow[]): PathGroup[] {
  const byKey = new Map<string, UnassignedRow[]>();
  for (const r of rows) {
    const key = r.cwd ? normCwd(r.cwd) : r.project ? `\u0000${r.project.toLowerCase()}` : rowKey(r);
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }
  const groups = [...byKey].map(([key, members]): PathGroup => {
    if (members.length === 1) return { key, head: members[0]!, members };
    const ids = [...new Set(members.flatMap((m) => m.account_ids ?? []))];
    return {
      key,
      members,
      head: {
        ...members[0]!,
        calls: members.reduce((s, m) => s + m.calls, 0),
        tokens: members.reduce((s, m) => s + m.tokens, 0),
        first_ts: members.reduce((a, m) => (m.first_ts < a ? m.first_ts : a), members[0]!.first_ts),
        last_ts: members.reduce((a, m) => (m.last_ts > a ? m.last_ts : a), members[0]!.last_ts),
        ...(ids.length ? { account_ids: ids } : {}),
      },
    };
  });
  return groups.sort((a, b) => b.head.tokens - a.head.tokens);
}

/** A rule being chosen (preview) or written; `done` waits for the reload that removes its rows. */
export type Pending = { rule: ProjectMatch; mark: "+" | "↩"; done: boolean };

export function idOf(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export type Track = (rule: ProjectMatch, mark: Pending["mark"], write: () => Promise<unknown>) => Promise<void>;

export function slugOf(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function vendorTone(vendor: string): "accent" | "violet" | "ok" {
  if (vendor === "claude") return "violet";
  if (vendor === "opencode") return "ok";
  return "accent";
}
