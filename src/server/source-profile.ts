import type { Database } from "bun:sqlite";
import { configFile, expandPath, LOGIN, MACHINE } from "../config/paths";
import { digest } from "../config/canonical-json";
import { readAccountsDocument } from "../config/accounts-document";
import { normEraKey } from "./eras";
import type { SourceProfileConfiguration, SourceProfileDeclaration, SourceProfileEdit } from "../shared/source-health";
import type { SetupSaveInput } from "./setup";

export function readSourceProfileConfiguration(sqlite: Database): SourceProfileConfiguration {
  const document = readAccountsDocument(configFile("accounts.json"));
  const declarations = (document.sources ?? []) as SourceProfileDeclaration[];
  return { revision: digest(document), machine: MACHINE, login: LOGIN, declarations,
    resolved: declarations.map(row => ({ archive: expandPath(row.home), profile: row.source_home ? expandPath(row.source_home) : null })) };
}

/** A focused edit never replaces another computer's declaration or changes historical ownership. */
export function prepareSourceProfileEdit(config: SourceProfileConfiguration, edit: SourceProfileEdit): SetupSaveInput {
  if (edit.revision !== config.revision) throw new Error("Konfiguracja zmieniła się. Zamknij edytor i otwórz go ponownie.");
  if (!["codex", "claude", "grok", "gemini"].includes(edit.vendor)) throw new Error("Ten dostawca nie korzysta z edytowalnego folderu profilu.");
  for (const field of [edit.profile, edit.archive]) {
    if (typeof field !== "string" || !field.trim()) throw new Error("Uzupełnij profil i archiwum.");
  }
  const rows = config.declarations.map(row => ({ ...row }));
  const previous = edit.index === null ? null : Number.isInteger(edit.index) ? rows[edit.index] : undefined;
  if (previous === undefined) throw new Error("Nie znaleziono edytowanego źródła.");
  if (previous && normEraKey(previous.machine) !== normEraKey(config.machine)) {
    throw new Error("Profil można zmienić na jego komputerze.");
  }
  if (previous && (previous.vendor !== edit.vendor || normEraKey(expandPath(previous.home)) !== normEraKey(expandPath(edit.archive)))) {
    throw new Error("Edycja profilu zachowuje dostawcę i archiwum. Drugiemu komputerowi dodaj osobne źródło.");
  }
  const profile = edit.profile.trim();
  if (rows.some((row, index) => index !== edit.index && row.vendor === edit.vendor &&
    normEraKey(row.machine) === normEraKey(config.machine) && row.source_home && normEraKey(expandPath(row.source_home)) === normEraKey(expandPath(profile)))) {
    throw new Error("Ten profil jest już przypisany na tym komputerze.");
  }
  const next: SourceProfileDeclaration = { ...previous, vendor: edit.vendor,
    machine: config.machine, login: config.login, home: previous?.home ?? edit.archive.trim(), source_home: profile };
  if (edit.index === null) rows.push(next); else rows[edit.index] = next;
  return { sources: rows, expectedSourceRevision: config.revision };
}
