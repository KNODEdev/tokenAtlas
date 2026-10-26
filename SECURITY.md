# Security policy

Report vulnerabilities privately to **dev@tokenatlas.dev** with the subject
`tokenAtlas security`. This is the contact already published on
[tokenatlas.dev](https://tokenatlas.dev/).

Include the affected version or commit, operating system, impact and a minimal
reproduction using synthetic data. Do not send passwords, access tokens, real
transcripts, account identifiers or database dumps. Ask for a suitable private
transfer method if a larger example is necessary. Avoid publishing exploitable
details in an issue before the maintainer has had a chance to investigate.

There is no guaranteed response time or paid bug bounty. Until a stable release
and maintenance policy are announced, fixes target the latest maintained source;
older snapshots are not promised security updates.

The application handles sensitive local AI history. Keep its HTTP server bound
to `127.0.0.1`; do not expose it through a public reverse proxy or an untrusted
network. The dashboard is intended for the local operator, not as a hosted,
multi-user service. Protect the archive, configuration, database and their backups
with the same care as the original provider history. See [PRIVACY.md](PRIVACY.md).

For ordinary bugs, use a public issue with a redacted or synthetic example.
