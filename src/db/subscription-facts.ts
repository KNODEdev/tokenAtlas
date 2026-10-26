/**
 * Raised by a reader whose provider's usage valuations are not prepared yet: the usage ledger
 * (Claude, Gemini, Grok, GLM) or the Codex price ledger. A report worker catches it, prepares the
 * provider outside its snapshot and reads again; a screen answers with the preparation state.
 * The versioned fact index this module held before was replaced by the usage ledger (migration 0047).
 */
export class SubscriptionFactsPending extends Error {
  constructor(message: string, readonly provider?: string) {
    super(message);
    this.name = "SubscriptionFactsPending";
  }
}
