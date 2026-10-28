import type { AccountResolver } from "../../server/account-resolver";

export interface FirstTokenTurn {
  id: string;
  model: string | null;
  service_tier?: string | null;
  effort?: string | null;
  ts: string;
  ms: number | null;
  billing: string;
  reason: string | null;
}
export interface FirstTokenAdapter {
  id: string;
  version: number;
  /** Source bookmark table; triggers enqueue only changed files. */
  files: { table: string; owner: string };
  prepared?: { table: string; owner: string; column: string };
  prepare?(pool: import("../../ingest/parse-pool").ParsePool, file: string): Promise<FirstTokenTurn[]>;
  /** Independent semantic reference for synthetic parser tests; not a production file reader. */
  parse(lines: Iterable<unknown>): FirstTokenTurn[];
  baseAccount(account: string): string;
  owner(resolver: AccountResolver, source: string, ts: string, billing: string): string | null;
}
