# Initial public source snapshot — 2026-10-25

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

The initial Windows parser release uses tag `parser-019adcdfd689`.
