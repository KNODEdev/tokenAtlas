import { NAVIGATION, navLocation, navText, sectionScreen, type NavSection, type ScreenId } from "../lib/screens";
import { BRAND_MARK } from "./brand-mark";
import { relativeTime, full } from "../lib/format";
import { translate, useI18n } from "../lib/i18n";
import { NAV_W, NAV_W_COLLAPSED } from "../lib/useBreakpoint";
import "./Sidebar.css";
// Six main entries and two system ones, from the one navigation registry (IA-2026-10-19 v1.1, IA-01, IA-14).
const MAIN = NAVIGATION.filter(section => !section.system);
const SYS = NAVIGATION.filter(section => section.system);
export function Sidebar({
  screen,
  goto,
  collapsed,
  onToggleCollapse,
  status,
  headerHeight = 52,
}: {
  screen: ScreenId;
  goto: (s: ScreenId) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  status: { cycleBadge?: string; cycleCount?: number; lastSync: string | null; calls: number | null; live: boolean };
  headerHeight?: number;
}) {
  const { language } = useI18n();
  const width = collapsed ? NAV_W_COLLAPSED : NAV_W;
  const active = navLocation(screen).section.id;
  const item = (n: NavSection, badge?: string) => {
    const label = navText(n.label, language);
    return (
      <button key={n.id} type="button" onClick={() => goto(sectionScreen(n))} aria-label={label} aria-current={active === n.id ? "page" : undefined}
        title={collapsed ? label : undefined} className="shell-nav-item">
        <span className="shell-nav-icon">{n.icon}</span>
        {!collapsed && <span>{label}</span>}
        {!collapsed && badge && <span className="shell-nav-badge">{badge}</span>}
      </button>
    );
  };
  return (
    // The navigation follows the app theme (paper on paper).
    <aside className={`shell-nav${collapsed ? " is-collapsed" : ""}`} style={{ width, flexBasis: width, top: headerHeight, height: `calc(100vh - ${headerHeight}px)` }}>
      <div className="shell-nav-brand"><Brand compact={collapsed} /></div>
      <nav className="shell-nav-list">
        {MAIN.map((n) => item(n, n.id === "overview" ? status.cycleBadge : n.id === "limits" && status.cycleCount != null ? String(status.cycleCount) : undefined))}
      </nav>
      <div className="shell-nav-rule" />
      <nav className="shell-nav-list is-system">{SYS.map((n) => item(n))}</nav>
      <div className="shell-nav-foot">
        {!collapsed && (
          <div className="shell-nav-status">
            <div className="shell-nav-live">
              <span className={`shell-nav-dot${status.live ? " is-live" : ""}`} />
              <strong>{status.live ? translate("Tracking active", "Śledzenie aktywne") : translate("No fresh data", "Brak świeżych danych")}</strong>
            </div>
            <div><span>{translate("last sample", "ostatnia próbka")}</span><span>{relativeTime(status.lastSync)}</span></div>
            <div><span>{translate("indexed", "zindeksowano")}</span><span>{status.calls != null ? full(status.calls) : "—"}</span></div>
          </div>
        )}
        <button type="button" onClick={onToggleCollapse} className="shell-nav-collapse"
          aria-label={collapsed ? translate("Expand navigation panel", "Rozwiń panel nawigacji") : translate("Collapse navigation panel", "Zwiń panel nawigacji")}
          title={collapsed ? translate("Expand navigation panel", "Rozwiń panel nawigacji") : translate("Collapse navigation panel", "Zwiń panel nawigacji")}>
          {collapsed ? "»" : `« ${translate("collapse", "zwiń")}`}
        </button>
      </div>
    </aside>
  );
}
// Map sheet with a route: the atlas grid and the way travelled across it.
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox={BRAND_MARK.viewBox} aria-hidden="true" focusable="false">
      <path className="brand-mark-grid" d={BRAND_MARK.grid} />
      <rect className="brand-mark-sheet" {...BRAND_MARK.sheet} />
      <path className="brand-mark-route" d={BRAND_MARK.route} />
      <circle className="brand-mark-end" {...BRAND_MARK.end} />
    </svg>
  );
}
export function Brand({ compact }: { compact?: boolean }) {
  return (
    <div className="brand" data-privacy-public title="tokenAtlas">
      <BrandMark />
      {!compact && <div className="brand-name"><span className="brand-word">token<span>Atlas</span></span><span className="brand-version">v0.9</span></div>}
    </div>
  );
}
