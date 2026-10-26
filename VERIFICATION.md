# Initial source snapshot — 25 October 2026

This is an actively developed desktop application, not a declaration of a stable
release. Verification was local on Windows with Bun 1.4.4, Cargo 1.99.0 and
Python 3.14.6. GitHub Actions are not used.

The selected source tree passed a locked Bun installation, TypeScript checking
and the web build in a disposable directory. The build reports some large chunks.
Six scoped account, period, identity, subscription-card and source tests passed
169/169 on both original and synthetic public fixtures. Parser tests passed
21/21; monitor tests passed 38/38. Production modules whose comments were
anonymised produced identical transpiled output.

The real server entry point started with a fresh isolated database, archive,
configuration, local state and user folders, with sync and probes disabled.
`/` and `/api/setup` returned 200, setup remained unconfigured and the server
was stopped after the trial. This checks an empty first start, not a fresh
Windows installation or a real-history import.

A broad test run encountered sandbox file-publication errors and other assertions
and was stopped. A full-suite pass is not claimed. The scoped tests were repeated
with exact file paths and workspace-local temporary state outside that sandbox
restriction. Private-history comparison and private-database measurement tests
are excluded from this source snapshot; their absence is not a passing result.

The portable Windows x64 parser uses the source hash in
`native/tokenatlas-parse/release.json` and was built with
`RUSTFLAGS=-Ctarget-cpu=x86-64-v2`. Its 53 build dependencies have complete copied
upstream notices, recorded in `licenses/windows-parser-dependencies.json`.
Four missing standalone notices in the complete cross-platform lockfile graph
are listed in `THIRD_PARTY_NOTICES.md`; those packages are absent from the
Windows parser artifact graph and are not bundled in this source tree.
No macOS/Linux binaries are distributed by this initial parser release.

The source snapshot contains no private development Git history, landing website,
installation database, transcript archive or dependency cache. Local secret
scanning found only a public OAuth client identifier and a checked stylesheet
hash; neither is an authentication secret. Synthetic fixtures include deliberate
invalid credentials/paths for validation tests. A scan is not proof of anonymity
or absence of every possible secret. Review exports and logs before sharing them.

The SVG used by the monitor icon generator is the application's own favicon;
its geometry matches the previously used mark. Font and dependency notices are
preserved separately from the project-owned artwork and brand policy.
