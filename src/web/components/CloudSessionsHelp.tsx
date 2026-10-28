import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../lib/i18n";
import { AccountPeriodDrawer } from "./AccountPeriodDrawer";
import { GhostButton } from "./ui";
import "./CloudSessionsHelp.css";

export function CloudSessionsHelpContent({ problems = [] }: { problems?: readonly string[] }) {
  const { t } = useI18n();
  return <>
    <section><h3>{t("Access", "Dostęp")}</h3>
    <p>{t("Importing Claude Code cloud history requires a valid sign-in and a trusted-device credential for the same local Claude profile. Signing in to the website alone does not provide that credential to the CLI.",
      "Import historii Claude Code z chmury wymaga aktualnego logowania i poświadczenia zaufanego urządzenia dla tego samego lokalnego profilu Claude. Samo zalogowanie do strony nie przekazuje tego poświadczenia do CLI.")}</p>
    <ol>
      <li>{t("Open the official Claude Code CLI with the affected profile and run /login. Complete the device verification when prompted.",
        "Uruchom oficjalne Claude Code CLI z profilem, którego dotyczy błąd, i wykonaj /login. Ukończ weryfikację urządzenia, gdy pojawi się prośba.")}</li>
      <li>{t("Review Trusted devices in your Claude account settings. Never copy tokens into tokenAtlas, GitHub issues or screenshots.",
        "Sprawdź Zaufane urządzenia w ustawieniach konta Claude. Nie kopiuj tokenów do tokenAtlas, zgłoszeń GitHub ani zrzutów ekranu.")}</li>
      <li>{t("Keep cloud import enabled in Settings → Computers and data. tokenAtlas retries on its saved interval; check that the next run completes without errors.",
        "Pozostaw import chmury włączony w Ustawienia → Komputery i dane. tokenAtlas ponawia odczyt w zapisanym odstępie; sprawdź, czy kolejny przebieg zakończył się bez błędów.")}</li>
    </ol></section>
    <section><h3>{t("Impact on results", "Wpływ na wyniki")}</h3>
    <p>{t("A failed import leaves previously archived history intact. New cloud usage may be missing from tokens, costs and project totals while provider limit percentages still include it. Missing history is not zero usage; comparisons involving it remain incomplete until import succeeds.",
      "Nieudany import zachowuje wcześniej zarchiwizowaną historię. Nowego ruchu z chmury może brakować w tokenach, kosztach i sumach projektów, choć procenty limitu dostawcy już go obejmują. Brak historii nie oznacza zerowego zużycia; porównania z jej udziałem pozostają niepełne do udanego importu.")}</p>
    <p>{t("Input and cache come from call records; completed-turn output comes from the provider's cumulative modelUsage totals. Output for an unfinished turn remains unmeasured.",
      "Wejście i cache pochodzą z rekordów wywołań; wyjście zakończonych tur z narastających sum modelUsage dostawcy. Wyjście niezakończonej tury pozostaje niezmierzone.")}</p></section>
    {!!problems.length && <section><h3>{t("Last import errors", "Błędy ostatniego importu")}</h3>
      <ul>{problems.map((problem, index) => <li key={`${index}:${problem}`}>{problem}</li>)}</ul></section>}
    <section><h3>{t("Documentation", "Dokumentacja")}</h3>
    <p><a href="https://github.com/KNODEdev/tokenAtlas/blob/main/docs/claude-cloud.md" target="_blank" rel="noreferrer">{t("tokenAtlas cloud import guide", "Instrukcja importu chmury tokenAtlas")}</a></p>
    <p><a href="https://code.claude.com/docs/en/remote-control#trusted-devices" target="_blank" rel="noreferrer">{t("Claude: Trusted Devices", "Claude: Zaufane urządzenia")}</a></p></section>
  </>;
}

export function CloudSessionsHelp({ problems = [] }: { problems?: readonly string[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const trigger = useRef<HTMLSpanElement>(null);
  return <>
    <span ref={trigger}><GhostButton onClick={() => { returnFocus.current = trigger.current?.querySelector("button") ?? null; setOpen(true); }}>
      {t("Cloud import details", "Szczegóły importu chmury")}
    </GhostButton></span>
    {open && createPortal(<AccountPeriodDrawer title={t("Claude cloud history", "Historia Claude w chmurze")}
      subtitle={t("Access and measurement coverage", "Dostęp i kompletność pomiaru")} busy={false}
      closeLabel={t("Close cloud import details", "Zamknij szczegóły importu chmury")} className="ui-detail-drawer cloud-sessions-help"
      onClose={() => setOpen(false)} returnFocus={returnFocus.current}>
      <CloudSessionsHelpContent problems={problems} />
    </AccountPeriodDrawer>, document.body)}
  </>;
}
