import fs from "node:fs";
import { configFile, expandPath } from "../config/paths";
import type { EraDeclaration } from "./eras";

interface LoadEraDeclarationsOptions {
  strict?: boolean;
  file?: string;
}

/** Frozen legacy account declarations used only by the historical test oracle. */
export function loadEraDeclarations(options: LoadEraDeclarationsOptions = {}): EraDeclaration[] {
  const file = options.file ?? configFile("accounts.json");
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { subscriptions?: EraDeclaration[] };
    return (parsed.subscriptions ?? []).map((sub) => ({
      ...sub,
      ...(sub.home ? { home: expandPath(sub.home) } : {}),
      ...(sub.source_home ? { source_home: expandPath(sub.source_home) } : {}),
    }));
  } catch (error) {
    if (options.strict) throw error;
    return [];
  }
}
