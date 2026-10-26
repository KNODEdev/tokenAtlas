# Paper atlas: the app in the landing page's language (2026-10-08)

The user asked for the whole app to look like the product page (`landing/styles.css` +
`landing/sketch.css`) and authorized the visual change. Structure, section order, controls and
navigation stay; appearance, spacing and sizes change. This file is the contract every screen is
built against. A screen is done when it follows every rule below, not when it "looks close".

The look is applied as a system: tokens (`tokens.css`, `components/ui.css`), primitives
(`components/ui.tsx`, `ui.css`, `index.css`) and then each screen. Never as an override layer,
never with `!important`, never with a value that is not a token.

## 1. Paper and ink (colour)

Cool near-white paper (no cream: warm paper clashed with the sea-blue accent, user 2026-10-08), ink
text, one sea-blue accent, pencil for outlines. Colour carries meaning only: figures and money are
ink, the accent marks the live/selected thing, ochre warns, brick means a limit was reached. Status and vendor colours are
muted inks and coloured pencils, never neon. All colours come from `tokens.css`:

| token | role |
|---|---|
| `--bg` | the paper sheet behind everything |
| `--surface` | a lighter sheet: cards, inputs, menus |
| `--raised` / `--sunk` | hover and recessed paper (tracks, wells) |
| `--band` | tinted band (status bar, side navigation, table heads) |
| `--line` | soft rule between rows and inside cards |
| `--line2` | card outline |
| `--pencil` | outline of things you click, header rule |
| `--text` / `--muted` / `--faint` | ink, secondary ink, tertiary ink |
| `--accent` / `--accent-soft` | the one emphasis colour and its wash |
| `--ok` / `--warn` / `--crit` (+ `-soft`) | status inks: green ink, ochre, brick |
| `--claude` `--codex` `--gemini` `--grok` `--glm` | vendor pencils |
| `--hatch` | the hatching drawn over filled bars and areas |

## 2. One family, and restraint

Everything is IBM Plex, the wordmark included. The handwritten Kalam was the wordmark's face until
2026-10-09; the user found it out of place in a precise tool and replaced it with Plex Sans
(see §6). Titles and labels in Kalam were rejected on 2026-10-08.

| voice | token | used for |
|---|---|---|
| title | `--font-display` (= Plex Sans) at `--fw-display` (600) | the screen title (`--fs-title`), a card's title (`CardTitle`, `.ui-display` at `--fs-card-title`), section and drawer titles (`--fs-section`), empty-state titles. One per card |
| text | `--font-sans` (IBM Plex Sans) | every other word: labels above figures (`Eyebrow`, `--fs-3`, medium, `--muted`), names, captions, controls, meta lines, table text |
| figure | `--font-figure` (IBM Plex Mono, tight tracking) | read-outs: KPI values, card percentages, numeric table columns, chart axis ticks |
| brand | `--font-brand` (= Plex Sans, 400 "token" / 600 "Atlas", -0.03em) | the wordmark only |

- **No capitals as style.** No `text-transform: uppercase`, no caps tracking. Sentence case.
- `.mono` is the data-text class: Plex Sans with tabular figures. Figures that should be Mono use
  `.ui-figure`, KPI values or `Td mono`.
- Sizes from the `--fs-*` scale only.

## 3. Few boxes

The page separates content with rules and bands, not frames.

- A **card** (`.ui-card`) is the only framed block: `--surface`, 1px `--line2`, `--r-card`,
  no shadow. Cards are not nested.
- Inside a card, groups are separated by a dashed rule (`--rule`), not by inner borders.
  An inner block that needs a well uses `--sunk` without a border.
- Table rows are separated by `--rule`; the head has a solid `--line2` rule.
- A KPI strip is an open row like Facts: dashed `--rule` above and below and between cells, the first figure on the
  content edge, never a row of boxes (user 2026-10-15). Screens stand on the paper without a page card; their
  cards drop frames on `.ui-tab-page` (Projects, Usage, Subscription rate, History, Compare, Models, Speed, Usage
  events, Data sources, 2026-10-15).

## 4. Pencilled edges, precise data

Hand-drawn character lives only on edges: irregular corners and the offset pencil shadow of
clickable things. Data stays geometric.

| token | shape |
|---|---|
| `--r-card` | card corners |
| `--r-control` | buttons, selectors, segmented options |
| `--r-chip` | pills, chips, inputs, small wells |
| `--r-bar` | meter tracks and bars |
| `--r-dot` | round markers (wobbly circle) |

- **Clickable = outlined, flat.** No offset shadow (it bends into a side stripe on rounded corners;
  `--lift` is transparent by decision). Buttons, selectors, chips you can press:
  1px `--pencil`, `--r-control`, `box-shadow: var(--lift)`. Pressed / selected: `--accent`
  outline, `--accent-soft` wash, `var(--lift-pressed)`. Disabled: no shadow.
- **Segmented switches** have no container frame; each option gets the pressed look when active
  (the landing's window switcher), with the same `--r-control` corners as buttons.
- **Bars** are a plain fill colour inside a `--sunk` track with a `--line` outline and `--r-bar`
  corners. No hatching on meters (it is noise at small sizes).
- **Selected = a wash, never a side bar.** A selected row, option or card gets `--accent-soft`
  behind it (hover is `--raised`). The two rails (subscription cards, windows) select with the
  neutral `--band` instead: a sea-blue wash that large read as a second colour (user 2026-10-10). No inset accent stripe on one edge: on rounded corners it bends
  into a curve (rejected by the user, 2026-10-08).
- Ornament budget: no offset shadows at all; popovers and menus float on the soft `--shadow` only.
- **Charts**: grid lines dashed `--line`, axis ticks in `--font-figure` `--fs-2` `--muted`,
  series strokes 1.75px with round caps, areas filled with a pale wash, no glow, no gradients.

## 5. Room

Generous but dense enough for a dashboard: card padding `--s-9`, gap between cards `--s-8`,
row height of tables 34px. The sheet has a faint paper grain.

## 6. Shell

- Header: on `--bg`, a single solid `--pencil` rule underneath (the double rule moved to the page tabs,
  user 2026-10-14). Brand (approved 2026-10-09): the map-sheet mark (a rounded sheet in ink, a faint
  `--accent-soft` grid, an `--accent` route ending in a dot) beside the wordmark in Plex Sans
  (`--font-brand`): "token" ink 400, "Atlas" accent 600. The collapsed rail shows the mark alone.
  The product page, favicons and `landing/logo-exports` use the same mark and wordmark.
- Side navigation follows the theme (paper on paper, `--band`), items in Sans 14/500,
  the active item gets the pressed look.
- Status bar under the header is a `--band` strip.

## 7. Workspace, facts and one switcher (user, 2026-10-12)

Built on Settings → Accounts and carried to every screen, one screen per pass.

- **Compact top.** The tabs stand right under the screen title. No card title that repeats the tab's name, no row
  holding a single switch with an empty right side. A setting stands beside what it changes ("As of" by the prices).
- **Tabs and switches are underlined labels**, never pressed buttons; buttons are for actions only.
- **Page tabs** (a tablist or `variant="sections"`, `DetailTabs` included) stand on the double pencil rule (one solid
  `--pencil`, one faint askew `--line`), labels at `--fs-6`, the chosen one semibold on a 3px `--accent` line (user,
  2026-10-14). Value switches (unit, range, order) and option groups keep the single rule. The double rule appears
  nowhere else.
- **Tabs under page tabs are the second level** (user, 2026-10-17): they belong to the tab chosen above, so they stand
  right under it on the single `--line2` rule, labels at `--fs-4`, the chosen one medium on a 2px `--accent` line. Only
  the first level keeps the double rule (e.g. Capacity → Selected subscription → Capacity · By model · …).
- **Section titles under page tabs carry no rule**: title and its meta line only, so the tabs' double rule stays the one
  strong line; a card under a section title does not repeat its window or name (user, 2026-10-14).
- **Row details open a drawer**, not a fold inside the table: a detail with its own columns (e.g. a model's dated rates)
  goes to the side drawer opened by clicking the row. One vocabulary serves every such table: the row is
  `.ui-open-row` (hover `--raised`, the opened row `.is-selected` keeps `--accent-soft`), its first cell holds a
  `.ui-open-row-button` (no frame of its own, so it may wrap a chip; a faint `›`, accent on hover and focus), and the
  drawer (`AccountPeriodDrawer`) takes `className="ui-detail-drawer"`: 860px wide, Facts on top, then sections
  (a `section` with an `h3`/`h4` at `--fs-5` semibold) divided by dashed `--rule`. No per-screen row or drawer classes.
  A value that is missing is said in words in `.ui-missing` (faint ink), not as a bare dash.
- **Workspace** (`.ui-workspace`, `useFillHeight`): a list on the paper (`.ui-workspace-rail`) and the chosen item on a
  lighter frameless sheet (`.ui-workspace-sheet`, `--surface`). Each column scrolls on its own; the page does not. The
  rail's first row may hold what applies to every item ("All accounts — overview").
- **Rail rows** (`.ui-rail-group`, `.ui-rail-heading` with the vendor dot and a count, `.ui-rail-item`): name and a
  flag (`.ui-rail-flag`, warn/crit) on the first line, a meta line under it; rows divided by dashed rules; items
  without current activity `.is-quiet`. The selected row takes the sheet's colour, so it joins the content.
- **Sheet head** (`.ui-sheet-head`): a small eyebrow (provider, id) over the item's name, its action on the right.
- **Facts** (`Facts`, `Fact`, `FactNote`): labelled values in one row between dashed rules: a short label, a clear
  value, and under it what it rests on. They replace loose grey lines.
- **One switcher** (`DetailTabs`): groups of tabs, named when there are several, always one open panel; it replaces
  stacked folds. Cards inside a panel drop their frames (§3).
- A page without a rail stands on the same sheet (`.ui-sheet`).

## Proof

- `src/web/paper-atlas.test.ts` fails on a component that writes a colour literal, a font name,
  `uppercase`, or a numeric `borderRadius`.
- Each screen is screenshot in both themes at 1440×900 and compared with the landing page.
