import { useMemo, useState } from "react";
import type { AtlasModel } from "../lib/cycle";
import type { ScreenId, Unit } from "../lib/screens";
import { NAVIGATION, screenAliases, screenLabel } from "../lib/screens";
import { useI18n } from "../lib/i18n";
import { MONO } from "./ui";

interface Command {
  id: string;
  label: string;
  hint: string;
  /** Former names that still find the command, never shown as entries of their own (IA-14). */
  aliases?: string[];
  run: () => void;
}

export function CommandPalette({
  model,
  onClose,
  goto,
  selectCycle,
  setUnit,
  toggleTheme,
}: {
  model: AtlasModel;
  onClose: () => void;
  goto: (s: ScreenId) => void;
  selectCycle: (index: number) => void;
  setUnit: (u: Unit) => void;
  toggleTheme: () => void;
}) {
  const { language, t } = useI18n();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);

  const commands = useMemo<Command[]>(() => {
    const nav = NAVIGATION.flatMap(section => section.tabs.flatMap(tab => tab.views.map(view => view.screen))).map((id: ScreenId) => ({
      id: `go:${id}`,
      label: screenLabel(id, language),
      hint: t("go", "przejdź"),
      aliases: screenAliases(id),
      run: () => goto(id),
    }));
    const cycles = model.cycles.slice(0, 14).map((c) => ({
      id: `cycle:${c.index}`,
      label: `${c.label}${c.isActive ? ` · ${t("current", "bieżący")}` : ""}`,
      hint: `${c.usedPercent.toFixed(0)}% ${t("allowance", "limitu")}`,
      run: () => {
        selectCycle(c.index);
        onClose();
      },
    }));
    const actions: Command[] = [
      { id: "unit:percent", label: t("Show unit: plan percentage", "Pokaż jednostkę: procent planu"), hint: t("unit", "jednostka"), run: () => { setUnit("percent"); onClose(); } },
      { id: "unit:tokens", label: t("Show unit: tokens", "Pokaż jednostkę: tokeny"), hint: t("unit", "jednostka"), run: () => { setUnit("tokens"); onClose(); } },
      { id: "unit:usd", label: t("Show unit: dollars (API prices)", "Pokaż jednostkę: dolary (ceny API)"), hint: t("unit", "jednostka"), run: () => { setUnit("usd"); onClose(); } },
      { id: "theme", label: t("Switch theme", "Przełącz motyw"), hint: t("appearance", "wygląd"), run: () => { toggleTheme(); onClose(); } },
    ];
    return [...nav, ...cycles, ...actions];
  }, [language, model, goto, selectCycle, setUnit, toggleTheme, onClose, t]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands.slice(0, 10);
    return commands.filter((c) => c.label.toLowerCase().includes(needle) || c.hint.toLowerCase().includes(needle)
      || c.aliases?.some(alias => alias.toLowerCase().includes(needle))).slice(0, 10);
  }, [q, commands]);

  const active = filtered[Math.min(cursor, filtered.length - 1)];

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40,
        background: "color-mix(in oklab, var(--bg) 72%, transparent)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "14vh",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 92vw)",
          background: "var(--surface)",
          border: "1px solid var(--pencil)",
          borderRadius: "var(--r-card)",
          boxShadow: "var(--shadow)",
          overflow: "hidden",
        }}
      >
        <input
          autoFocus
          value={q}
          placeholder={t("Search a screen, cycle, or action...", "Szukaj ekranu, cyklu lub akcji...")}
          onChange={(e) => {
            setQ(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, filtered.length - 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            }
            if (e.key === "Enter" && active) active.run();
          }}
          style={{
            width: "100%",
            padding: "13px 15px",
            background: "transparent",
            border: "none",
            borderBottom: "1px solid var(--line2)",
            outline: "none",
            color: "var(--text)",
            fontSize: "var(--fs-6)",
            fontFamily: "var(--font-sans)",
          }}
        />
        <div style={{ maxHeight: 320, overflowY: "auto", padding: 6 }}>
          {filtered.length === 0 && (
            <div className="mono" style={{ padding: "18px 12px", fontSize: "var(--fs-4)", color: "var(--muted)" }}>
              {t("No matches.", "Brak dopasowań.")}
            </div>
          )}
          {filtered.map((c, i) => {
            const on = c.id === active?.id;
            return (
              <button
                key={c.id}
                onMouseEnter={() => setCursor(i)}
                onClick={c.run}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: "var(--r-control)",
                  border: "1px solid " + (on ? "var(--accent)" : "transparent"),
                  background: on ? "var(--accent-soft)" : "transparent",
                  color: on ? "var(--text)" : "var(--muted)",
                  fontSize: "var(--fs-5)",
                  fontFamily: "var(--font-sans)",
                  cursor: "pointer",
                }}
              >
                <span>{c.label}</span>
                <span style={{ fontFamily: MONO, fontSize: "var(--fs-2)", color: "var(--faint)" }}>{c.hint}</span>
              </button>
            );
          })}
        </div>
        <div
          className="mono"
          style={{
            padding: "7px 12px",
            borderTop: "var(--rule)",
            fontSize: "var(--fs-2)",
            color: "var(--faint)",
            display: "flex",
            gap: 14,
          }}
        >
          <span>↑↓ {t("navigate", "nawigacja")}</span>
          <span>⏎ {t("select", "wybierz")}</span>
          <span>esc {t("close", "zamknij")}</span>
        </div>
      </div>
    </div>
  );
}
