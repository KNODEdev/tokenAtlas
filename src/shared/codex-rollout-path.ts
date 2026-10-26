export const isCodexRollout = (file: string): boolean => /\.jsonl(?:\.zst)?$/i.test(file);
export const compressedRollout = (file: string): boolean => /\.jsonl\.zst$/i.test(file);
/** Storage representation is not part of a conversation or copy identity. */
export const rolloutIdentity = (file: string): string => file.replace(/(\.jsonl)\.zst$/i, "$1");
export const isArchivedCodexRollout = (relative: string): boolean =>
  /^codex[/\\][^/\\]+[/\\](?:sessions|archived_sessions)[/\\].+\.jsonl(?:\.zst)?$/i.test(relative);
