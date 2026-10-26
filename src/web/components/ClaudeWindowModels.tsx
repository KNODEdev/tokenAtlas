import type { WindowModelUsage } from "../../shared/window-model-usage";
import { useI18n } from "../lib/i18n";
import { totalWindowTokens } from "../lib/window-tokens";
import { Card, EmptyState } from "./ui";
import { WindowModelTable } from "./WindowModelTable";

export function ClaudeWindowModels({ rows }: { rows: WindowModelUsage[] | null | undefined }) {
  const { t } = useI18n();
  if (rows == null) return <EmptyState title={t("Model detail is not prepared yet", "Szczegóły modeli jeszcze nieprzygotowane")}
    detail={t("The stored window answer has no token breakdown yet.", "Zapisana odpowiedź okna nie ma jeszcze rozbicia tokenów.")} />;
  if (!rows.length) return <EmptyState title={t("No model traffic in this window", "Brak ruchu modeli w tym oknie")} />;
  const unpriced = rows.reduce((sum, row) => sum + row.unpriced_tokens, 0);
  return <Card>
    <WindowModelTable tableId="ClaudeWindowModels:0" rows={rows.map(row => ({ ...row, model: row.model || "?",
      api: totalWindowTokens(row) > row.unpriced_tokens
        ? { total: row.api_standard, pricedTokens: totalWindowTokens(row) - row.unpriced_tokens } : null,
    })).sort((a, b) => totalWindowTokens(b) - totalWindowTokens(a) || a.model.localeCompare(b.model))} />
    {unpriced > 0 && <div className="codex-models-coverage">{t("Some tokens have no dated API rate; ≥ marks the priced part.", "Część tokenów nie ma datowanej stawki API; ≥ oznacza wycenioną część.")}</div>}
  </Card>;
}
