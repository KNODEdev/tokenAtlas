# tokenAtlas

Desktop analytics for AI coding usage: compare models, projects, subscriptions,
billing cycles and observed limits from one local history.

Explore the product and illustrated guide at [tokenatlas.dev](https://tokenatlas.dev/).

This is the initial public source snapshot, under active development. See
[VERIFICATION.md](VERIFICATION.md) for the locally checked scope and limitations.

## What you can explore

- Usage by model and project, including token counts and cache usage.
- Subscription costs, billing cycles and observed usage limits.
- API-equivalent costs alongside allocated subscription costs.
- Model speed and time to first token, where the source provides verified measurements.

tokenAtlas keeps provider originals in an archive and calculates a local SQLite
register incrementally. The dashboard reads prepared results. API-equivalent
cost, allocated subscription cost and provider-reported percentages are distinct
measures; missing evidence is not treated as zero or an invoice.

## Existing integrations

The source includes integrations for Codex, Claude Code, OpenCode, Grok and
Gemini / Antigravity. Integration coverage varies by tool and available source data;
inclusion does not mean that every metric or quota reader is available.

Gemini / Antigravity and Grok already have import and limit-reading components,
with further work planned below. Gemini CLI account discovery does not currently
have a connected quota reader. Verified time-to-first-token measurements are
currently available for Codex; other sources remain unmeasured for this metric.

## Planned development

We are developing tokenAtlas into a shared place to compare usage across AI tools:

- **Refine Gemini / Antigravity and Grok integrations:** improve data collection,
  limit readings and measurement coverage.
- **Expand integrations:** bring in measurements from additional tools and providers,
  and extend coverage of their models.
- **Extend performance measurements:** broaden speed and time-to-first-token
  coverage where sources provide reliable evidence.

These are development directions, with no committed release dates. Integrations
will expand incrementally as provider data becomes available and can be verified.
Suggest a source or describe a missing measurement in
[GitHub Issues](https://github.com/KNODEdev/tokenAtlas/issues).

## Project information

- License: [Apache-2.0](LICENSE), with attribution in [NOTICE](NOTICE)
- Data handling: [PRIVACY.md](PRIVACY.md)
- Private vulnerability reports: [SECURITY.md](SECURITY.md)
- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md)

## Requirements

Windows is the currently verified desktop development path. The launcher uses
PowerShell, curl and Bun. Building the native parser from source requires stable
Rust and the Visual Studio C++ build tools with Windows SDK. `_dev.bat` can use a
published parser only when its source hash and SHA-256 match the release manifest.
Availability of that binary must be verified for the public release; source builds
are the fallback. macOS and Linux native sources exist, but this preparation does
not certify their installation or runtime. Mobile is not a supported target.

Use a current Bun compatible with the committed lockfile. This preparation was
checked with the versions recorded in [VERIFICATION.md](VERIFICATION.md).

## Start on Windows

1. Obtain a reviewed source release and extract it to a writable local directory.
2. Install Rust/MSVC if no matching public parser binary is available.
3. Run `_dev.bat`. It checks dependencies, prepares the parser, builds the web
   interface and starts the local server.
4. Open `http://127.0.0.1:7331`. On a new installation, confirm the archive and
   source folders in setup before the first import. Configure account history and
   subscriptions in Settings.

An existing `.env` is not required. `.env.example` documents optional overrides.
OneDrive is optional. Keep the database on local storage, outside the source
archive. Never import another user's account declarations or database.

Choose the local database folder during setup or in Settings. The installation saves that
choice in private `tokenatlas.local.json`; machine identity and local preferences live in
`local-state/` beside the selected database. Moving the database through Settings also copies
that state and keeps the original as recovery evidence. Existing managed `.env` selections
are migrated automatically; manual environment setup is not required.

Do not expose the local API to a public network. Provider sessions and archives
can contain conversation text and credentials; review [PRIVACY.md](PRIVACY.md)
before connecting or sharing data. Back up private data before upgrades.

## Local verification

From the source directory, with Bun and Rust/MSVC installed:

```powershell
bun install --frozen-lockfile
bun run typecheck
bun test ./src ./scripts
cargo test --locked --manifest-path native/tokenatlas-parse/Cargo.toml
cargo test --locked --manifest-path native/tokenatlas-monitor/Cargo.toml
bun run build:web
```

Run builds and installation trials in a disposable copy: `build:web` writes to
`public/`, and starting the server can create or migrate the selected database.
Tests that explicitly require private integration data do not establish a clean
installation pass when that data is absent. Verification is local; this project
does not use GitHub Actions.

## License, attribution and support

Project-owned code, including the native parser and monitor, is offered under
Apache-2.0. Third-party dependencies and fonts retain their licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `licenses/`.
The project name and logo follow [TRADEMARKS.md](TRADEMARKS.md); the code license
does not imply endorsement of a fork. Contributions retain their authorship.

The program is provided without warranty under its license. Calculated figures
are analytical observations and estimates, not provider billing statements.
Support is voluntary: [SUPPORT.md](SUPPORT.md). Report ordinary bugs with a small,
synthetic reproduction and include the source version and checks you ran.
