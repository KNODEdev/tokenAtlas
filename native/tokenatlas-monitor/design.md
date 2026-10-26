# Native widget vocabulary and scope

Screen mode, 2026-10-17: the user's subscription-card/chart captures and the
current paper-atlas contract are the reference. The user specifically rejected
the Windows system title bar and requested connecting recorded chart points
through missing readings. Scope: native monitor app/native/model/common/store,
its demo caller, and its documentation; no main tokenAtlas appearance changes.

- Tokens: `src/web/tokens.css`, accessed through `theme::token`; shared size
  constants generated from `src/web/components/ui.css` by build.rs.
- Primitives: egui panels, existing token-backed theme, plain egui buttons,
  ComboBox and the existing chart mesh/stroke renderer. No CSS is emitted.
- Idiom: native projection of the existing palette/type/spacing vocabulary,
  reusing the theme's egui control states rather than a parallel stylesheet.
- Contract: IBM Plex, one accent, no gradient/shadow/nested frames, compact
  labels with details in tooltips. Header uses bg/text/accent and existing
  SMALL/TITLE/GAP sizes; minimize and close reuse flat Button controls.
- Unit (user follow-up, 2026-10-18): one narrow widget, 360px wide, with height
  measured from the actual first two cards and capped to the desktop work area.
  Cards stack vertically; further cards scroll, at most
  eight panels. Smaller existing font/spacing tokens and a 108px plot keep each
  card compact. Native decorations are disabled; a narrow integrated title bar
  provides drag/minimize/close and the approved map-sheet mark.

No new palette, size token or primitive variant. Chart time gaps connect existing
samples linearly; no samples are generated or stored. A reset or percentage
reduction still breaks the series, including reductions hidden by downsampling.

Follow-up: user authorized multiple charts plus remaining time/allowance and
consumption forecasts. Reuse the existing card/plot and token-backed open Facts
layout. Each stable panel has its own account/window choice; global refresh,
add and settings move into the shared header. No new token or control variant.
Remaining %, %/hour and time to 100% form three short labelled values. Exact
forecast instants, sample basis, age and assumptions remain in tooltips.

The application icon is generated from `landing/favicon-mark.svg`; no replacement
logo is drawn. The same PNG supplies the native window and integrated header,
with ICO for Windows executable resources and ICNS for the macOS bundle.
