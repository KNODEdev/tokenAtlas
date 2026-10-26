import fs from "node:fs";
import { atomicArchiveWrite } from "../sync/archive-publication";
import { createHash } from "node:crypto";
import type { RateCard } from "./pricing";
import type { CodexAccountingRule } from "../shared/codex-accounting";
import { configWriteTarget } from "../config/paths";
import { withContextRates } from "./rate-cards-file";
import { longContextPremium, resolveCodexAccountingConfig, validateCodexAccountingConfig } from "./codex-accounting-pricing";
import type { CodexPricingEdit, CodexPricingSettings } from "../shared/codex-pricing-settings";
import { legacyCodexLedgerSettings, prepareLegacyCodexLedgerEdit } from "./codex-ledger-legacy-settings";
import type { CodexLedgerEffects } from "./codex-ledger-settings";
export type { CodexPricingEdit, CodexPricingSettings } from "../shared/codex-pricing-settings";

export function codexPricingSettings(card: RateCard): CodexPricingSettings {
  if (card.codex_ledger_policy !== undefined) return legacyCodexLedgerSettings(card);
  const config = resolveCodexAccountingConfig(card);
  return { revision: createHash("sha256").update(JSON.stringify(config)).digest("hex"), rules: config.rules,
    long_context_premium: longContextPremium(config) };
}

/** Overlay only the selected model, billing basis and mode; preserve both sides. */
export function editCodexPricingPeriod(card: RateCard, edit: CodexPricingEdit): RateCard {
  if (card.codex_ledger_policy !== undefined) return prepareLegacyCodexLedgerEdit(card, edit).card;
  const current = resolveCodexAccountingConfig(card);
  if (edit.revision !== codexPricingSettings(card).revision) throw new Error("Cennik zmienił się. Odśwież dane przed zapisem.");
  if (edit.long_context_premium !== undefined) {
    if (typeof edit.long_context_premium !== "boolean" || edit.rule || edit.remove || edit.replace_id)
      throw new Error("Zmiana dopłaty za długi kontekst jest osobnym zapisem.");
    // Absent means the premium applies, so switching it back on restores the earlier digests.
    const { long_context_premium: _previous, ...rest } = current;
    const config = edit.long_context_premium ? rest : { ...rest, long_context_premium: false };
    validateCodexAccountingConfig(config);
    return { ...card, codex_accounting: config };
  }
  if (Boolean(edit.remove) === Boolean(edit.rule)) throw new Error("Wybierz jeden okres do zapisu lub usunięcia.");
  if (edit.replace_id && !edit.rule) throw new Error("Brak zastępującego okresu.");
  const removedId = edit.remove ?? edit.replace_id;
  if (removedId && !current.rules.some(rule => rule.id === removedId)) throw new Error("Nie znaleziono okresu.");
  let rules = current.rules.filter(rule => rule.id !== removedId);
  if (edit.rule) {
    const incoming = { ...structuredClone(edit.rule), confidence: "user" as const };
    validateCodexAccountingConfig({ version: 1, rules: [incoming] });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(incoming.model)) throw new Error("Podaj dokładny identyfikator modelu (do 120 znaków, bez spacji).");
    if (incoming.id.length > 512 || incoming.sources.length > 20 || incoming.sources.some(source => {
      try { const url = new URL(source); return url.protocol !== "https:" || !url.hostname || !!url.username || !!url.password || source.length > 4000; }
      catch { return true; }
    })) throw new Error("Nieprawidłowe źródło HTTPS lub identyfikator okresu.");
    if (rules.some(rule => rule.id === incoming.id)) throw new Error("Identyfikator okresu jest już używany.");
    rules = rules.flatMap(rule => {
      if (rule.model !== incoming.model || rule.billing_basis !== incoming.billing_basis || rule.speed !== incoming.speed
        || rule.valid_from >= (incoming.valid_until ?? "9999-12-31") || incoming.valid_from >= (rule.valid_until ?? "9999-12-31")) return [rule];
      const parts: CodexAccountingRule[] = [];
      if (rule.valid_from < incoming.valid_from) parts.push({ ...rule, valid_until: incoming.valid_from });
      if (incoming.valid_until && incoming.valid_until < (rule.valid_until ?? "9999-12-31")) {
        parts.push({ ...rule, id: parts.length ? `${rule.id}:split:${crypto.randomUUID()}` : rule.id, valid_from: incoming.valid_until });
      }
      return parts;
    });
    rules.push(incoming);
  }
  const config = { ...current, rules };
  validateCodexAccountingConfig(config);
  return { ...card, codex_accounting: config };
}

export async function handleCodexPricingSettings(ctx: { rateCards: RateCard }, req: Request,
  target = configWriteTarget("rate-cards.json"),
  onLedgerChange?: (effects: CodexLedgerEffects) => void): Promise<Response> {
  const response = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  if (!["GET", "POST"].includes(req.method)) return response({ error: "Method not allowed" }, 405);
  let edit: CodexPricingEdit | undefined;
  if (req.method === "POST") {
    try { edit = await req.json(); } catch { return response({ error: "Oczekiwano JSON." }, 400); }
    if (!edit || typeof edit.revision !== "string" || (edit.remove !== undefined && typeof edit.remove !== "string")
      || (edit.replace_id !== undefined && typeof edit.replace_id !== "string")
      || (edit.long_context_premium !== undefined && typeof edit.long_context_premium !== "boolean")) return response({ error: "Nieprawidłowy zapis okresu." }, 400);
  }
  try {
    // Read fresh persisted settings so another browser's save cannot be lost.
    const card: RateCard = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : ctx.rateCards;
    const settings = codexPricingSettings(card);
    if (!edit) return response(settings);
    if (edit.revision !== settings.revision) return response({ error: "Cennik zmienił się. Odśwież dane przed zapisem." }, 409);
    let next: RateCard, ledgerChange: ReturnType<typeof prepareLegacyCodexLedgerEdit> | undefined;
    try {
      if (card.codex_ledger_policy !== undefined) { ledgerChange = prepareLegacyCodexLedgerEdit(card, edit); next = ledgerChange.card; }
      else next = editCodexPricingPeriod(card, edit);
    } catch (e) { return response({ error: (e as Error).message }, 400); }
    if (!ledgerChange || ledgerChange.changed) atomicArchiveWrite(target, JSON.stringify(next, null, 2) + "\n");
    ctx.rateCards = withContextRates(next);
    if (ledgerChange?.changed) onLedgerChange?.(ledgerChange.effects);
    return response({ ...codexPricingSettings(next), ...(ledgerChange ? { ledger_effects: ledgerChange.effects,
      ...(ledgerChange.undo_token ? { undo_token: ledgerChange.undo_token } : {}) } : {}) });
  } catch (e) { return response({ error: (e as Error).message }, 503); }
}
