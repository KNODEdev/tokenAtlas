import path from "node:path";
import { archiveSourceIdentity } from "../shared/archive-codec-path";
import { selectArchiveRepresentation } from "./archive-codec";
const sessionUuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Companions are linked inside one source, never by session id across computers. */
export function identityCompanion(store: string, file: string): string | null {
  file = archiveSourceIdentity(file);
  // A cloud session's events are read with the declaration beside them (places and owner).
  const cloud = /^(.+)\.events\.jsonl$/i.exec(file);
  if (cloud) return `${cloud[1]}.session.jsonl`;
  if (store === "desktop" && /^[0-9a-f]{8}-audit\.jsonl$/i.test(path.basename(file))) return file;
  const parent = path.dirname(file);
  if (path.basename(parent) === "subagents" && sessionUuid.test(path.basename(path.dirname(parent)))) {
    return selectArchiveRepresentation(path.dirname(parent) + ".jsonl");
  }
  const desktop = store === "desktop" && path.basename(file).match(/^([0-9a-f]{8})-([0-9a-f-]{36})\.jsonl$/i);
  return desktop ? path.join(parent, desktop[1] + "-audit.jsonl") : null;
}

