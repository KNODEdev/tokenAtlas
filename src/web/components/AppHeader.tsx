import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ApiAccount } from "../lib/api";
import type { ScreenId } from "../lib/screens";
import { isLanguage, LANGUAGE_OPTIONS, useI18n } from "../lib/i18n";
import { Brand } from "./Sidebar";
import { Selector } from "./ui";
import "./AppHeader.css";
import { setPrivacyEnabled, usePrivacy } from "../lib/privacy";
import { subscriptionPlan } from "../lib/subscription-plan";
import { setContextPreview, useContextPreview, useContextPreviewCoverage } from "../lib/context-premium";
function initials(machine: string | null, login: string | null): string {
  const a = (machine ?? "").trim()[0] ?? "";
  const b = (login ?? "").trim()[0] ?? "";
  const both = (a + b).toUpperCase();
  return both || "··";
}
export function AppHeader({
  account,
  accounts,
  theme,
  onToggleTheme,
  onOpenPalette,
  goto,
  onMobileNav,
  compact,
  activity,
  contextPreviewApplies = false,
}: {
  account: string;
  accounts: ApiAccount[];
  theme: "dark" | "light";
  onToggleTheme: () => void;
  onOpenPalette: () => void;
  goto: (s: ScreenId) => void;
  onMobileNav?: () => void;
  compact?: boolean;
  activity?: ReactNode;
  contextPreviewApplies?: boolean;
}) {
  const { language, setLanguage, t } = useI18n();
  const hidden = usePrivacy();
  const contextPreview = useContextPreview();
  const contextCoverage = useContextPreviewCoverage();
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  const current = accounts.find((a) => a.id === account) ?? null;
  const login = current?.login ?? null;
  const machine = current?.machine ?? null;
return (
    <header className={`shell-header${compact ? " is-compact" : ""}`}>
      {onMobileNav && (
        <button type="button" onClick={onMobileNav} aria-label={t("Menu", "Menu")} className="shell-header-menu">☰</button>
      )}
      {compact && <Brand compact />}
      <button type="button" onClick={onOpenPalette} title={t("Command palette", "Paleta komend")} className="shell-search">
        <span>⌕</span>
        {!compact && (
          <>
            <span className="shell-search-text">{t("Search account, cycle, project…", "Szukaj konta, cyklu, projektu…")}</span>
            <span className="shell-search-key">Ctrl K</span>
          </>
        )}
      </button>
      {activity}
      <button type="button" role="switch" className="shell-context" aria-checked={contextPreview} data-on={contextPreview ? "" : undefined}
        data-unsupported={contextPreview && (!contextPreviewApplies || contextCoverage !== null) ? "" : undefined}
        title={t("Preview: adds OpenAI's long-context price uplift (requests above the threshold, e.g. 272K input tokens) to the API amounts, as the paid API would charge. Applies to Capacity, Plan comparison and Traffic history window values. Nothing is saved and no setting changes; it starts off every time.", "Podgląd: dolicza do kwot API dopłatę OpenAI za długi kontekst (żądania powyżej progu, np. 272K tokenów wejścia), tak jak naliczyłoby płatne API. Działa na Pojemności, Porównaniu planów i wartościach okien Historii ruchu. Nic się nie zapisuje i nie zmienia ustawień; zawsze startuje wyłączony.")
          + (contextPreview && !contextPreviewApplies ? t(" Amounts on this screen do not include the preview yet.", " Kwoty na tym ekranie nie uwzględniają jeszcze podglądu.") : "")
          + (contextPreview && contextCoverage === "preparing" ? t(" Context prices are being prepared; stored amounts are retained.", " Ceny kontekstu są przygotowywane; zachowano zapisane kwoty.") : "")
          + (contextPreview && contextCoverage === "missing" ? t(" Context prices are incomplete; stored amounts are retained.", " Ceny kontekstu są niepełne; zachowano zapisane kwoty.") : "")}
        onClick={() => setContextPreview(!contextPreview)}>
        <span className="shell-context-track" aria-hidden="true"><span /></span>
        {compact ? t("Ctx", "Kont.") : t("OpenAI context in price", "Kontekst OpenAI w cenie")}
      </button>
      <button type="button" className="shell-privacy" aria-pressed={hidden}
        aria-label={hidden ? t("Reveal sensitive data", "Odkryj dane wrażliwe") : t("Hide sensitive data", "Ukryj dane wrażliwe")}
        title={t("Screen-sharing privacy: hides emails, accounts, machines, projects and paths, including tooltips and report exports. Read-only while enabled. Source data and network responses remain unchanged.", "Prywatność ekranu: ukrywa maile, konta, maszyny, projekty i ścieżki, także w podpowiedziach i eksportach raportów. Po włączeniu tylko odczyt. Dane źródłowe i odpowiedzi sieciowe pozostają bez zmian.")}
        onClick={() => setPrivacyEnabled(!hidden)}>
        <svg className="shell-control-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
          <circle cx="12" cy="12" r="3" />
          {hidden && <path d="m3 3 18 18" />}
        </svg>
        {!compact && (hidden ? t("Privacy on", "Dane ukryte") : t("Hide data", "Ukryj dane"))}
      </button>
      <button type="button" className="ui-button shell-theme" onClick={onToggleTheme}
        aria-label={theme === "dark" ? t("Switch to light theme", "Włącz jasny motyw") : t("Switch to dark theme", "Włącz ciemny motyw")}
        title={theme === "dark" ? t("Switch to light theme", "Włącz jasny motyw") : t("Switch to dark theme", "Włącz ciemny motyw")}>
        <svg className="shell-control-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          {theme === "dark" ? <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
          </> : <path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z" />}
        </svg>
      </button>
      <Selector
        ariaLabel={t("Language", "Język")}
        title={t("Language", "Język")}
        value={language}
        onChange={value => { if (isLanguage(value)) setLanguage(value); }}
        options={LANGUAGE_OPTIONS.map(({ value, label }) => ({ value, label }))}
      />
      <div ref={box} className="shell-user">
        <button
          type="button"
          onClick={() => setMenu((m) => !m)}
          aria-label={hidden ? t("Account menu", "Menu konta") : undefined}
          aria-expanded={menu}
          className="shell-user-button"
          title={current ? `${current.id}${current.plan ? ` · ${subscriptionPlan(current.vendor ?? "", current.plan)}` : ""} · ${current.vendor ?? "?"}` : t("No account selected", "Brak wybranego konta")}
        >
          <span className="shell-user-initials">{hidden ? "" : initials(machine, login)}</span>
          {!compact && (
            <span className="shell-user-name">
              <span>{login ?? "—"}</span>
              <span>{machine ?? "—"}</span>
            </span>
          )}
          <span className="shell-caret">▾</span>
        </button>
        {menu && (
          <div className="shell-user-menu">
            <div className="shell-user-menu-head">
              <div>{login ?? "—"}</div>
              <div>{machine ?? "—"} · {accounts.length} {accounts.length === 1 ? t("account", "konto") : t("accounts", "konta")}</div>
            </div>
            <div className="shell-user-menu-list">
              <MenuItem icon="◇" label={t("Accounts and limits", "Konta i limity")} onClick={() => { setMenu(false); goto("sources"); }} />
              <MenuItem icon="⚙" label={t("Settings", "Ustawienia")} onClick={() => { setMenu(false); goto("settings"); }} />
              <MenuItem icon="⌘" label={t("Keyboard shortcuts", "Skróty klawiszowe")} hint="Ctrl K" onClick={() => { setMenu(false); onOpenPalette(); }} />
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
function MenuItem({ icon, label, hint, onClick }: { icon: string; label: string; hint?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="shell-menu-item">
      <span className="shell-menu-icon">{icon}</span>
      <span className="shell-menu-label">{label}</span>
      {hint && <span className="shell-menu-hint">{hint}</span>}
    </button>
  );
}
