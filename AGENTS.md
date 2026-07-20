# AGENTS.md

See [CLAUDE.md](./CLAUDE.md) for the project entry point. The original
bootstrap spec is preserved verbatim at
[docs/SPEC.md](./docs/SPEC.md); the live roadmap is at
[docs/GARRISON_ROADMAP.md](./docs/GARRISON_ROADMAP.md).

One rule worth repeating here because it shapes every UI decision: Garrison
runs on one machine but is **used from other machines and mobile over the
HTTPS tailnet address** — never hand the browser a machine-local absolute URL
(see "Instances, ports, and deploying" in CLAUDE.md for the full rule and the
loopback + tailnet URL-pair pattern).
