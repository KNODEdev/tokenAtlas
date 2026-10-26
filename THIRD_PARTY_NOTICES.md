# Third-party software and assets

Project-owned code, including `native/tokenatlas-parse` and
`native/tokenatlas-monitor`, is offered under [Apache-2.0](LICENSE).
Copyright and project attribution are recorded in [NOTICE](NOTICE).
This does not change the licenses of dependencies or third-party assets.

## Dependency inventory

`licenses/dependencies.json` records installed JavaScript package versions and
the complete registry graph in both native Cargo lockfiles, including build,
test and other-platform dependencies. `licenses/third-party.txt` preserves the
upstream license and notice texts. Input lock hashes are included in the JSON.

Regenerate after changing dependencies:

```powershell
bun install --frozen-lockfile
python scripts/release/collect-licenses.py
```

The script uses local package notices and checksum-verified Cargo archives.
Missing npm notices are supplemented from upstream source; the copied text
records whether the npm version provided a pinned source revision or a current
upstream notice was used. An upstream notice supplement is not proof of a
historical package's license. Verify those cases before binary redistribution.

The inventory is not a claim that every dependency has the project's license,
or that all SPDX alternatives apply simultaneously. Preserve applicable
copyrights and notices and review copyleft/source-offer requirements for the
actual components and targets being distributed. Source releases do not bundle
`node_modules`, Cargo caches, the Bun runtime or build-tool binaries.

The current inventory has four dependency versions without standalone upstream
notice texts: `dispatch 0.2.0`, `drm-fourcc 2.2.0`, and `r-efi 5.3.0 / 6.0.0`.
The collector writes the inventory and exits with code 2 while notices are
missing. These are other-target dependencies; resolve the applicable notice
requirements before distributing a binary for those targets. This source
review package does not redistribute their crate contents.

## Fonts

IBM Plex fonts retain SIL Open Font License 1.1. The monitor embeds
`scripts/usage-monitor-assets/ibm-plex-sans.ttf` and
`native/tokenatlas-monitor/assets/IBMPlexMono-Regular.ttf`. Keep their complete
OFL notices with source and binary distributions:

- `scripts/usage-monitor-assets/LICENSE.txt` (IBM Plex Sans)
- `native/tokenatlas-monitor/assets/OFL-IBM-Plex-Sans.txt`
- `native/tokenatlas-monitor/assets/OFL-IBM-Plex-Mono.txt`

The web dashboard loads IBM Plex through Google Fonts; see [PRIVACY.md](PRIVACY.md).
The GUI framework also has its own font/dependency notices in the generated
inventory; project font notices do not replace them.

## Branding and other artwork

The project name and marks follow [TRADEMARKS.md](TRADEMARKS.md). A logo or
screenshot in a private development directory is not automatically approved
for a public release. Marketing packs, real-data screenshots, operational
reports and private history are excluded from the proposed public source copy.
Third-party names are used to identify integrations, without implying endorsement.
