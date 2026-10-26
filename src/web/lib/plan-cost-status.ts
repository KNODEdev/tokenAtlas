import type { BillingUnavailableReason } from "../../shared/plan-price-coverage";
import { translate } from "./i18n";

/** Render backend reasons consistently; a missing allocated bill is not necessarily a missing offer price. */
export function billingUnavailable(reasons: readonly BillingUnavailableReason[] = []): { label: string; hint: string } {
  const labels: Record<BillingUnavailableReason, [string, string, string, string]> = {
    plan_history_gap: ["plan history gap", "luka historii planu",
      "Part of this subscription's selected history has no established plan. A global catalog price cannot identify which plan was held then.",
      "Część wybranej historii abonamentu nie ma ustalonego planu. Globalna cena katalogowa nie określa, jaki plan obowiązywał w tym czasie."],
    plan_price_missing: ["price unavailable", "brak wyceny",
      "A dated plan or billing cycle has no established price.", "Okres planu lub cykl płatności nie ma ustalonej ceny."],
    fx_rate_pending: ["FX rate pending", "kurs w drodze",
      "A recorded payment awaits its exchange rate. The catalog price does not replace the payment.",
      "Zapisana płatność czeka na kurs waluty. Cena katalogowa nie zastępuje płatności."],
    usage_incomplete: ["incomplete usage", "niepełne zużycie",
      "Incomplete or conflicting usage prevents splitting the subscription bill between projects.",
      "Niepełne lub sprzeczne dane zużycia uniemożliwiają podział rachunku między projekty."],
    no_pricing_span: ["cost unavailable", "brak kosztu",
      "No traffic span is available to calculate a calendar cost.", "Brak zakresu ruchu potrzebnego do obliczenia kosztu kalendarzowego."],
  };
  const known = [...new Set(reasons)].map(reason => labels[reason]).filter(Boolean);
  return {
    label: known.length === 1 ? translate(known[0]![0], known[0]![1]) : translate("cost unavailable", "brak kosztu"),
    hint: known.length ? known.map(row => translate(row[2], row[3])).join("\n")
      : translate("The subscription's calendar cost cannot be allocated from the available data.", "Dostępne dane nie pozwalają przydzielić kosztu kalendarzowego abonamentu."),
  };
}
