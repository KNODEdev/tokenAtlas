# Native file parser (R1a / R1b / R1d)

`codex` implements the pure `prepareFullRollout(file, size)` contract. It reads
only that prefix of the input file and never opens a database or writes source files.
`claude` implements `parseClaudeJsonl(store, file, since, ownerCache, limitHits)`
and returns `{events, limitHits}`. It reads transcripts and their source-local
identity companions only. R1d adds `grok` (`parseUpdates`), `gaugesJournal`
(`readJournalSuffix`), `gemini` (`parseGeminiConversation`) and `opencode`
(`readOpencodeSnapshot`). Unsupported formats return
`{id, ok:false, code:"unsupported", message:...}`.

Build from PowerShell on Windows (Git Bash may select Git's incompatible `link.exe`):

```powershell
cargo build --release --manifest-path native/tokenatlas-parse/Cargo.toml
cargo test --manifest-path native/tokenatlas-parse/Cargo.toml
cargo clippy --manifest-path native/tokenatlas-parse/Cargo.toml -- -D warnings
bun test src/ingest/rust-parse.test.ts
bun scripts/rust-parse-compare.ts --workers 4 --all
bun scripts/rust-parse-compare.ts --format claude --workers 4 --all
```

`_dev.bat` calls `scripts/dev/build-native-parser.ps1`. With Rust and MSVC tools
it builds the parser; without them it downloads the binary published for the
current sources (`release.json`: tag, asset, SHA-256) and checks its checksum.
The binary stays under the crate's ignored `target/release/`, with a `.version`
stamp holding the source hash it belongs to. The version is the SHA-256 over
`Cargo.toml`, `Cargo.lock`, `src/` and the release RUSTFLAGS
(`scripts/dev/native-parser-version.ts`).

After changing any of those, publish a new binary from PowerShell on a machine
with Rust, MSVC and a signed-in `gh`, then commit the rewritten `release.json`
(`src/ingest/native-parser-release.test.ts` fails until you do):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\build-native-parser.ps1 -Publish
```

The first process argument is the worker count. stdin and stdout contain only
frames: a four-byte **little-endian unsigned length**, followed by UTF-8 JSON.
Requests and responses follow `ParseRequest` / `ParseResponse` in
`src/ingest/parse-pool.ts`. Responses may arrive in any order; their request IDs
preserve the caller's ordering. Each file's records retain their original order.
Call grouping is local to each request. Companion identity results are shared by
physical path, size and modification time, checked again after reading. Missing
companions are not cached; changed or deleted companions cannot reuse old owners.
The bounded cache does not link session IDs across source directories.

`ParsePool` uses the native child for all six providers when its binary exists.
Fingerprinting and JSONL validation keep the Bun workers. Gemini and OpenCode
use native parsing only for archived snapshots; provider originals keep their
WAL-aware Bun reader. Both native and Bun archive readers verify standalone
files and their bytes/metadata before and after reading; native rusqlite opens
only the source URI with `mode=ro&immutable=1`. No atlas database is opened by Rust. `TOKENATLAS_NATIVE_PARSER=0` disables the native child;
`TOKENATLAS_PARSE_WORKERS=0` retains the existing in-process path. Startup,
protocol or process failures retry outstanding and queued work in Bun, with one
fallback log per application process. The child inherits Bun's effective IANA
timezone for local `Date.parse` forms, including Bun's UTC test environment.
The comparison harness requires native
execution and fails instead of silently timing Bun as Rust.

The golden corpus covers f64 rounding and Python-style decimal formatting,
UTF-16 escapes, JS property ordering, duplicate keys, BOM rejection, invalid
UTF-8 replacements, raw SHA-256/offset evidence, LF/CRLF, U+2028/U+2029, partial
prefixes, metadata-only state, rich/count pairing and conflicting duplicates.
The comparison harness hashes the complete canonical result and every row,
including valuations' source events, limits, evidence and parser state.
It runs Rust twice and checks file sizes and modification times across all phases.
Its parse timers sum bounded windows of twice the worker count, including file
reads, IPC and response decoding. Canonicalization/hashing runs between those
windows; separate comparison wall times include that work. Exclusions are printed
before the run. These are not stage/publication or end-to-end sync timings.

Claude golden files under `tests/golden/claude/` add SDK/transcript merging,
`since`, desktop audit and subagent companions, owner conflicts, cache refresh
on creation/change/deletion, ISO normalization and extended years, RFC/local
dates, UTF-16 identity/path traps, and structured/text limit refusals. Text
resets use IANA zones, including DST gaps/folds, fractional offsets and leap-year
rollover, with vendor refusals taking precedence over text for the same call.
The Claude comparison also reports raw assistant timestamp counts, rejected
timestamps and observed non-ISO forms outside its parse timers, and checks
companion metadata across phases. A subset manifest can supply each file's
`store`, `size`, and nanosecond `mtime`; explicit file arguments use `--store`
(default `live`). `--all` discovers both live and desktop archive profiles.

Codex acceptance run on 2026-10-02 (Bun 1.4.0, Rust 1.95 MSVC):

- `cargo test`: 4 passed; `cargo clippy -- -D warnings`: clean.
- Golden/pool tests: 10 passed, 143 assertions. Full ingestion and requested
  Codex sync suites: 94 passed, 2 existing price-ledger failures, 628 assertions.
  An earlier run had three 5-second fixture timeouts; the final quiet run passes
  those tests with their original timeouts (96 tests / 24 files / 98.96 seconds).
- `bunx tsc --noEmit -p .`: only the five errors listed in the brief, no new errors.
- Launcher helper builds successfully and its simulated missing-Cargo path exits
  successfully with the fallback message. `_dev.bat` retains CRLF.
- Whole archive: 15,471 files, 3,363,343 hashed rows, zero TS/Rust mismatches and
  zero differences between Rust runs. Counts: 1,348,043 facts, 936,759 events,
  78,466 limits, 936,759 event proofs, 16,903 session headers, plus three metadata
  hashes per file. Inputs retained their captured sizes and modification times.

| Four workers, eight-file windows | Parse + IPC seconds | Comparison wall seconds |
| --- | ---: | ---: |
| TS | 97.676 | 226.038 |
| Rust | 359.765 | 522.205 |
| Rust repeat | 397.803 | 553.239 |

**Open performance issue:** native parsing/transport is slower than Bun in this
harness. The SIMD tag/LF scans and scalar-only UTF-8 validation repairs preserve
exactness but do not establish a speed gain. Do not treat this as performance
acceptance or an end-to-end rebuild improvement. `TOKENATLAS_NATIVE_PARSER=0`
retains Bun execution. Release downloads remain deliberately deferred.

The complete final comparison header and summary are in the worktree-local,
ignored `TMP/rust-parse-compare-final.log`.

Claude R1b readable-subset verification on 2026-10-02 (Bun 1.4.2, Rust 1.95 MSVC):

- `cargo test`: 9 passed; `cargo clippy -- -D warnings`: clean; release build passed.
- `bun test src/ingest/rust-parse.test.ts src/ingest/parse-pool.test.ts`: 15 passed,
  332 assertions. Claude ingest/sync suites: 16 passed across eight files, 95 assertions.
- `bunx tsc --noEmit -p .`: only the five existing errors (price-ledger API probe,
  three data-view-clock fixture errors, and the global-usage fixture comparison).
- Entry point: `ParsePool.run('claude', {file,store})` / `parseClaudeJsonl`,
  read-only, four workers, application-default lookahead (TS 8, Rust 64).
  Sample: 12,811 readable files of 14,020 discovered; 1,209 inaccessible files
  excluded. All 428,427 row hashes match (427,953 events, 474 limit hits), as do
  every file hash and both Rust runs. Source and companion metadata stayed stable.
  All 775,015 raw assistant timestamps are parseable ISO forms; no non-ISO forms
  were found in this subset. Synthetic legacy date cases remain in the goldens.
- Isolated read/parse/transport seconds: TS **43.774**, Rust **15.588**, Rust repeat
  **14.914**. Comparison wall seconds: 85.507 / 66.369 / 71.098. The isolated timers
  exclude timestamp diagnostics, discovery/stat, canonicalization/hashes and
  previous-phase GC; all timers exclude archive writes, database work, stage,
  validation and publication. This is not an end-to-end import measurement.

The subset manifest and final report are worktree-local ignored files:
`TMP/claude-readable.json` and `TMP/rust-claude-compare-final.log`.
Whole-archive acceptance is pending the lead's unrestricted read access:

```powershell
bun scripts/rust-parse-compare.ts --format claude --workers 4 --all
```

R1d readable-subset verification on 2026-10-02 (Bun 1.4.2, Rust 1.95 MSVC):

The pure readers are in `src/ingest/{grok,gauges,gemini,opencode}-parse.ts`.
Synchronous importer APIs retain the same writer through a shared generator;
async importers, the production sync adapters and the existing CLIs use the
pool with Bun fallback. Writer semantics, project annotations, history hydration,
raw Grok ticks, OpenCode reported costs and Gemini synthetic USD stay in TS.
Compact gauge expansion still resolves accepted facts in the TS writer. Gauge
pool batches are bounded to 4 MiB (or one longer line), carrying complete raw
bytes for the existing one-pass accepted-prefix hash, including malformed UTF-8.
A process-close subscription is installed at spawn to avoid missing Bun's close
notification while shutting down a native child.

Goldens under `tests/golden/other/` cover JSON property order, duplicate/scalar
precision, surrogate escapes, overflow, raw ticks, UTF-8 replacement, LF/CRLF,
partial tails, compact/canonical records, offsets, raw-byte batches and prefix
hashes. Reviewed JSON recipes build SQLite fixtures with WAL headers, URI-special
characters, conversation/mtime timestamps, protobuf repeats/truncation, strict
UTF-8 and missing models. Tests also exercise writer retry/correction, TS pricing,
immutable fences, native failure fallback and process shutdown.

Entry points: `ParsePool.run` for each format and the matching pure TS reader.
Mode: read-only, four workers, pool-default lookahead (TS 8, Rust 64).
Sample: every readable file from production archive discovery; pre-read for
readability, then sequential TS/Rust/repeat phases. These are warm file-reader
and transport measurements, including archive SQLite verification. The new
importer writers consume file tasks sequentially; this harness isolates the
shared reader APIs with the pool lookahead. Gauge comparisons request the whole
suffix and prefix digest; the bounded writer's raw-byte batches are covered by
the golden and incremental-write tests. Timers exclude
initial discovery/readability checks, canonicalization/hashing, stability stats,
previous-phase GC, pricing, DB writes, stage, validation and publication. They
are not end-to-end import or rebuild measurements.

| Provider | Readable / discovered | Source rows | TS seconds | Rust seconds | Rust repeat |
| --- | ---: | ---: | ---: | ---: | ---: |
| Grok | 17 / 74 | 45 | 0.101 | 0.046 | 0.055 |
| Gauges | 21 / 23 | 35,754 | 0.530 | 0.919 | 0.896 |
| Gemini | 283 / 286 | 19,205 | 2.122 | 3.479 | 3.742 |
| OpenCode | 2 / 2 | 4,150 | 2.018 | 3.505 | 4.693 |

All file and row hashes match; both Rust runs are deterministic and input metadata
stays stable. The 62 inaccessible files remain excluded: whole-archive acceptance
is pending the lead's read access. Grok improves on this sample; the other three
formats do not establish a speed gain. Ignored manifests and full logs are in
`TMP/{provider}-readable.json` and `TMP/r1d-{provider}-compare.log`.

Checks: `cargo test --offline --locked --manifest-path native/tokenatlas-parse/Cargo.toml`
passes 11 tests; `cargo clippy --offline --locked --manifest-path native/tokenatlas-parse/Cargo.toml -- -D warnings`
and formatting are clean. The release build uses the repository's x86-64-v2
configuration. A worktree-local `CARGO_HOME=TMP/cargo-home` uses cached crates
because the sandbox cannot unpack new sources into the normal Cargo home.
The lockfile retains existing versions and adds only rusqlite's dependencies.
`bun test src/ingest/rust-parse.test.ts src/ingest/parse-pool.test.ts --timeout 60000`
passes 20 tests / 419 assertions. The four importers plus dirty-range/exact-file
suites pass 40 tests / 229 assertions with `--timeout 120000`; the requested
sync suites plus Gemini identity/diagnostics pass 17 / 164 assertions with the
same timeout. Earlier runs hit fixture timeouts under concurrent compilation;
the final parser and ingest runs pass. The sync run initially lacked access to
`probe-source-corrections.json`; the final run sets `TOKENATLAS_CONFIG` to an
empty worktree-local test directory and `TOKENATLAS_FROZEN_CONFIG=1`.
`bunx tsc --noEmit -p .` reports only the five pre-existing errors (price-ledger
API probe, three data-view-clock fixtures, global-usage fixture). There was no
live database access, archive write, migration/restart, commit or push.

Whole-archive commands for the lead:

```powershell
bun scripts/rust-parse-compare.ts --format grok --workers 4 --all
bun scripts/rust-parse-compare.ts --format gauges --workers 4 --all
bun scripts/rust-parse-compare.ts --format gemini --workers 4 --all
bun scripts/rust-parse-compare.ts --format opencode --workers 4 --all
```
