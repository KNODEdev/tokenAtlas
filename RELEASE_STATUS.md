# Public Windows source preview — 2026-10-29

Install through the ordinary GitHub path: **Code → Download ZIP**, extract the
complete folder, then run `_dev.bat`. No separate application package is required.
The launcher downloads Windows x64 parser `parser-0ab55c4340b9` and verifies its
SHA-256 against `native/tokenatlas-parse/release.json`; Rust/MSVC is optional when
using that published parser. The source remains under active development.

Local preparation passes a frozen dependency installation, TypeScript checking,
an isolated frontend build, 21 parser and 38 monitor Rust tests, and a fresh
isolated first-start HTTP trial with 20 JS/CSS assets. Snapshot fixture repair
passes 28 tests; four migration/import integration files pass 17 tests with a
30-second default budget. Parser-manifest and transaction checks pass 6 tests.

The broad suite is not a clean pass: its default five-second budgets interrupted
several integrations, and a project-cost fixture reported an immutable base-proof
mismatch. This preview does not certify a stable release, clean-PC installation,
real-history import or macOS/Linux support. The owner's clean-PC trial is separate.
See VERIFICATION.md for scope and retained earlier evidence.

The repository supports Issues and Discussions. Its Sponsor button points to the
public GitHub Sponsors profile and the official website's support section.
Contributions and financial support remain independent.

## Initial source snapshot — 2026-10-25

This package contains only the tokenAtlas application. The website repository
and the private development Git history are excluded. Project-owned code is
Apache-2.0; preserve LICENSE and NOTICE. This is an initial source snapshot,
not a stable application release. See VERIFICATION.md for exact scope.

Checked locally on Windows: locked Bun install, typecheck, web build, 169 scoped
tests on both original and synthetic fixtures, 21 parser and 38 monitor Rust
tests, and the real API entry serving / and /api/setup from a fresh isolated
database. Transpiled production output matches after comment anonymisation.
This does not certify a full test-suite pass, a new-machine installation,
real-history import or macOS/Linux support.

The public repository is KNODEdev/tokenAtlas; development history remains in the
private KNODEdev/tokenAtlasOrigin. Official SVG artwork and monitor icon sources
are included under the project copyright license, with the brand policy applied
separately. The Windows parser's matching source hash and binary SHA-256 are in
its release manifest; all 53 dependencies in that binary's build graph have
copied upstream notices. Four other-target dependency versions still lack
standalone notices; no binaries for those targets are distributed. See
THIRD_PARTY_NOTICES.md. Source archives do not bundle dependency caches or
third-party binaries.

The private measurement/migration scripts and the private-history compatibility
test listed in the preparation report are omitted intentionally. Private account
examples were replaced by synthetic values; the originals were not modified.

The current Windows parser release is identified by `native/tokenatlas-parse/release.json`.
The manifest records the public release tag, source hash and binary SHA-256 together.
