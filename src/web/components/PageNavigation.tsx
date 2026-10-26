import { useEffect, useRef, type ReactNode } from "react";
import { navLocation, navText, type ScreenId } from "../lib/screens";
import { useI18n } from "../lib/i18n";
import { HelpDot, Tabs } from "./ui";
import "./PageNavigation.css";

/**
 * A menu entry's page tabs and the open tab's views, both from the navigation registry
 * (IA-2026-10-19 v1.1, IA-19: two visible levels at most). Nothing renders for a single view.
 */
/** The page tabs stay pinned under the screen head (`top`) while the report scrolls (user, 2026-10-21). */
export function PageTabs({ screen, open, top, onHeight }: {
  screen: ScreenId; open: (screen: ScreenId) => void; top?: number;
  /** Reports the row's height (0 without tabs), so a report can pin its own row right below it. */
  onHeight?: (height: number) => void;
}) {
  const { language, t } = useI18n();
  const { section, tab } = navLocation(screen);
  const shown = section.tabs.length > 1 || tab.views.length > 1;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = ref.current;
    if (!row) { onHeight?.(0); return; }
    if (!onHeight || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => onHeight(row.offsetHeight));
    observer.observe(row);
    return () => observer.disconnect();
  }, [shown, onHeight]);
  if (!shown) return null;
  return (
    <div ref={ref} className="page-tabs" role="group" aria-label={t("Page tabs", "Zakładki strony")} style={top === undefined ? undefined : { top }}>
      {section.tabs.length > 1 && <Tabs variant="sections" value={tab.id}
        onChange={id => open(section.tabs.find(item => item.id === id)!.views[0]!.screen)}
        options={section.tabs.map(item => ({ value: item.id, label: navText(item.label, language) }))} />}
      {tab.views.length > 1 && <Tabs value={screen} onChange={open}
        options={tab.views.map(item => ({ value: item.screen, label: navText(item.label, language) }))} />}
    </div>
  );
}

/**
 * The one scope line above a report (IA-42): short parts in the page, exact bounds in the help,
 * actions that act on this scope at the end.
 */
export function ContextBar({ parts, help, actions }: { parts: string[]; help?: ReactNode; actions?: ReactNode }) {
  const { t } = useI18n();
  if (parts.length === 0) return null;
  return (
    <div className="context-bar" aria-label={t("Report scope", "Zakres raportu")}>
      <span className="context-bar-scope mono">{parts.join(" · ")}</span>
      <HelpDot label={t("Report scope", "Zakres raportu")}>{help}</HelpDot>
      {actions && <span className="context-bar-actions">{actions}</span>}
    </div>
  );
}
