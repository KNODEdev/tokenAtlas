# Styling vocabulary — tokenAtlas

Checked 2026-10-25 against the active source. The design contract is `paper-atlas.md`.

- Tokens: `src/web/components/ui.css` owns the paper-atlas theme, Plex type scale,
  spacing (`--s-*`), colours and corner tokens. `src/web/tokens.css` holds the retained
  base. Components use these shared CSS custom properties.
- Primitives: `Card`, `CardTitle`, `Facts`, `Fact`, `HelpDot`, `HelpBlock`, `Table`,
  `TableRow`, `Th`, `Td`, `EmptyState`, `LoadingCard`, `ErrorState`, `Tabs` and
  `AccountPeriodDrawer` in `src/web/components/ui.tsx` and the shared table modules.
- Composition: `.ui-open-row`, `.ui-open-row-button`, `.is-selected`,
  `.ui-detail-drawer`, `.mono` and the existing `.codex-models-*` share-track,
  composition-bar, legend-dot and coverage classes.
- Idiom: component stylesheets and token-based inline layout; global appearance
  belongs to the shared primitives. No colour/font/radius literals, uppercase
  styling, nested cards, offset shadows or mobile layouts.
- Current unit: Overview → Models and traffic, for Claude and Codex. The supplied
  screenshot is the layout reference. The shared model table and token composition
  reuse existing primitives; no new appearance tokens or primitives are needed.

The model table, its input definitions and the token composition are shared. Provider
adapters supply quantities and valuation availability. Calibration remains in Data
and calibration. Other screens and the application shell are outside this change.
