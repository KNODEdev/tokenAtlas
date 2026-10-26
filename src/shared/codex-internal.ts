/** Runtime identity for Codex's internal action reviewer, not a public model. */
export function isCodexInternalReview(model: string | null | undefined): boolean {
  return model === "codex-auto-review";
}
