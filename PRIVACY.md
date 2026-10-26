# Data and privacy

tokenAtlas reads AI coding history and publishes calculated usage in a local
desktop dashboard. Its archive can contain original conversation text, tool
arguments, source snippets, paths and account metadata even when a chart shows
only anonymous totals. The SQLite database, logs and exports can also identify
accounts, machines and projects. They are private installation data.

## Storage and sharing

Choose the archive, database and configuration through setup and Settings.
An archive on a cloud-synchronised or shared folder is shared under that service's
settings; it is not anonymous. Keep the calculated database on local storage.
Copying the source repository is different from backing up your installation:
keep account declarations, `.env`, transcripts, databases and recovery copies out
of Git. Do not attach them to public issues.

Export only the fields you intend to share. A screenshot can reveal identifiers
in labels, tooltips, paths and browser chrome. Small aggregates and exact dates
can still identify activity. Review the final exported artifact before sharing;
renaming an account alone does not establish anonymity.

## Network access

The dashboard and API bind to loopback by default. Local storage does not mean
the program is fully offline: configured account probes and cloud-session sync
can contact providers with locally available authentication; price and exchange
rate refreshes contact their sources. Setup/build may download dependencies and
a matching native parser. The web dashboard currently requests IBM Plex fonts
from Google Fonts. Provider, font-host and cloud-storage policies apply to those
requests. tokenAtlas is an independent project, not an official provider client.

## Removing data

Disconnecting a source or uninstalling source code does not erase the growing
archive, database or backups. Stop the application and any companion monitor,
then remove only the locations selected for that installation if you want to
erase them. Check cloud copies, recycle bins and backup retention separately.
Keep a recovery copy before intentional deletion. Do not delete provider history
as a substitute for removing tokenAtlas's copies.

Send privacy-sensitive reports to **dev@tokenatlas.dev**; use synthetic examples.
