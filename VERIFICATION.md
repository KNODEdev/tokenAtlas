# Initial source snapshot — 25 October 2026

## Public Windows installation preparation — 29 October 2026

Verification used a clean `git archive` of `2a8dd02` with a frozen Bun install,
workspace-local temporary storage and synthetic databases. The installed app,
live database and existing archive were not changed. A later concurrent PNG-export
commit is outside this run's source scope. All checks were local; no GitHub Actions
were used.

TypeScript checking and the isolated frontend build pass. The build still reports
chunks larger than 500 kB. Locked Rust tests pass 21/21 for the parser and 38/38 for
the monitor. The new portable Windows parser was built with Cargo 1.99.0 and
`RUSTFLAGS=-Ctarget-cpu=x86-64-v2`; all 53 dependencies in its Windows graph have
copied notices, and all three lockfile hashes match the notice inventory.

Parser helper release `parser-0ab55c4340b9` is published on GitHub, with the binary,
checksums and notices. Its source hash is
`0ab55c4340b9f467b6301b09ef0022a6aa3ba4d27f6e268d0cd7b7f3dafee536`;
the binary SHA-256 is
`0c146478744f71cb6f3fb0b7092e0dc4ac84e24064a6a13b59cfcf113e58246f`.
This closes the stale parser-manifest mismatch described below. It is a helper
release for the source installer, not a stable application release.

A fresh server using isolated home/config/archive/state/database paths returned
200 for `/`, `/api/setup?summary=1` and all 20 referenced JS/CSS assets. First-run
locations were unconfirmed, import remained stopped, and a foreign-origin setup
request returned 403. The trial server was closed afterwards. This is a first-start
smoke check, not the owner's forthcoming clean-PC acceptance trial.

The broad default-budget test run is not a clean pass. It exposed a stale snapshot
fixture lacking the Codex `source_offset` column and an implicit rollback-journal
read transaction. The fixture now includes that column and the read explicitly
uses `BEGIN DEFERRED`, preserving SQLite's prior behavior. The repaired snapshot
file passes 28/28 tests (270 assertions); manifest and transaction checks pass 6/6.
Four migration/import files that had hit five-second deadlines pass 17/17 with a
30-second default budget (297 assertions), retaining their data and performance
assertions. Other broad-run failures include a project-cost fixture's immutable
base-proof mismatch; a clean full-suite pass is not claimed. The README records
the 30-second integration command for repeatability.

Gitleaks 8.30.1 scanned all 39 reachable commits through `4019ae7`. The same two
generic-key findings were inspected in their original commit: an OAuth client ID
(also present in the distributed CLI) and the exact Git blob SHA-1 of
`src/web/tokens.css`, independently reproduced with `git hash-object`. They are
not access credentials. No findings were suppressed and no history was rewritten.

Standard user acceptance is **GitHub → Code → Download ZIP → `_dev.bat`** with
anonymous parser download. A specially assembled local bundle is not an acceptance
path. Linux/macOS installation, real provider sign-in/import and all UI states
remain outside this preparation's verified scope.

After publishing `6c3e237`, the ordinary public GitHub main source download was
fetched without credentials. It contained no parser binary. The unchanged
`build-native-parser.ps1` downloaded `parser-0ab55c4340b9` with an empty GitHub CLI
configuration and Rust/MSVC detection disabled; its checksum matched the manifest.
This checks the public installer download path. The owner's clean-PC trial still
establishes the complete installation experience.

The older broad baseline run was stopped after 45 reported failure cases and was
not completed. That count includes the subsequently repaired snapshot fixture,
transaction and manifest cases, plus integration timeouts and remaining
project-cost base-proof / compressed-source pipeline mismatches. Do not interpret
the combined scoped repair results as a clean full-suite result. Synthetic fixture
databases were removed after verification; compact reports and logs were retained.

## Test repair follow-up — 28 October 2026

The 18 failures recorded in the 27 October audit were mapped back to their 14 test
files and rechecked on `6fd24ce` with the local follow-up changes. Most of the old
migration, private-history, transaction, journal, activity and cost failures had
already been repaired in that commit. The remaining architecture failure was two
missing declarations for the timing projection producer and its prepared reader;
their reads and ownership-boundary sums were inspected before adding exact counts.

Additional checks found stale TTFT version-1 expectations in the native parser
goldens and account-filter fixtures that had not prepared the new timing register.
Those fixtures now use the current adapter contract and run the background producer
before reads; their value and ownership assertions remain intact. Native parsing
and import checks pass 14/14, account-filter checks pass 11/11, architecture and
transaction checks pass 6/6, and TypeScript checking passes.

The documented 14-file scope ran 201 tests: 197 passed and four snapshot cases hit
the old deadline. After the file-local timeout correction, all 28 snapshot tests
passed in 69.38 seconds, closing that scope across the two runs (173 other tests
plus 28 snapshot tests). This is a combined scoped result, not a new full-suite run.
Concurrent startup/snapshot implementation edits appeared in the shared working
tree during verification; they were preserved and are not attributed to this repair.

Snapshot integration tests now have a file-local 30-second budget, the 90,000-row
bulk/reference comparison has 60 seconds, and the two-order compressed-source
import test has 30 seconds. The former five-second deadlines killed working
backup/decoder processes under suite load. No data assertion or performance-work
bound was removed. Verification uses synthetic databases and workspace-local
temporary storage; Windows sandbox restrictions on hardlinks and junctions require
these filesystem integration checks to run outside that sandbox.

The attempted full `bun test ./src ./scripts --only-failures` run was interrupted
to finish the documented regression scope; it is not a full-suite pass. A separate
release blocker remains: `src/ingest/native-parser-release.test.ts` correctly
rejects the published parser manifest because its source hash differs from the
current Rust sources. This test and the manifest were deliberately preserved.
Publishing a matching binary requires a separately authorized parser tag/release.
No live database, server, installed frontend or release was changed by this repair.

## Follow-up source audit — 27 October 2026

The application repository is public and has independent history; the landing source
and private development archive remain separate. Gitleaks 8.30.1 scanned all 16
reachable commits and the reviewed working source. Its two findings were checked:
a public OAuth client identifier and a stylesheet integrity hash, not access secrets.
Tracked files and reachable path history contain no installation database, local
account declarations, dependency cache, landing tree or GitHub Actions workflow.
Commit author metadata and an old illustrative machine name remain identifying metadata.

The source follow-up passes TypeScript checking, an isolated web build, 61 focused
regression tests, 171 HTTP regression tests, 21 native-parser tests and 38 monitor tests. React Doctor 0.9.13
reported no issues in its 44-file changed-source scope. Browser checks of synthetic
data confirmed cloud-import warnings, English/Polish help drawers, recovery and
unavailable states, modal focus restoration and the reported privacy regressions.

A broader local run was stopped after 865 passes and 18 failures; it did not finish
the full suite. Nine failures were also reproduced in an unmodified HEAD source
copy, including stale architecture/transaction guards, legacy migration fixtures
and a test requiring an absent historical Git object. This is not a full-suite or
stable-release pass. The live UI was surveyed across eight navigation areas, but
some views remained loading and provider authentication prevented complete coverage.

These are source checks. They do not activate the updated server, billing rules or
frontend in an existing installation. Claude cloud history still requires valid
sign-in for the affected local profile; see [the cloud import guide](docs/claude-cloud.md).

## Original snapshot checks

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
