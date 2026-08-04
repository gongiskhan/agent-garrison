# Instances - ports, lifecycles, and how changes reach each environment

The single source of truth for port math is `src/lib/instance-profile.ts`
(mirrored by `scripts/garrison-instance.sh`). The committed compositions carry
ONE port map (the 7xxx family); every instance is that map plus a fixed
offset. This doc is the operational companion: what runs where, how each
instance is started, and when code changes actually take effect.

## Instance table

| | dev | prod | codex |
|---|---|---|---|
| offset | 0 | +1000 | +20000 |
| app (Next) | 127.0.0.1:7777 | 127.0.0.1:8777 | 127.0.0.1:27777 |
| gateway (http-gateway) | 4777 | 5777 | 24777 |
| outpost host | 3702 | 4702 | 23702 |
| scheduler health | 7099 | 8099 | 27099 |
| fittings | 70xx | 80xx | 270xx |
| `GARRISON_HOME` | `~/.garrison-dev` | `~/.garrison` | `~/.garrison-codex` |
| Claude config | `~/.claude-garrison-dev` (via `CLAUDE_CONFIG_DIR`) | the REAL `~/.claude` (`CLAUDE_CONFIG_DIR` unset) | `~/.claude-garrison-codex` |
| Next dist dir | `.next` (`next dev`) | `.next-prod` (`next start`, prebuilt) | `.next` |
| started by | `npm run dev` (systemd user unit `garrison-dev.service` when installed) | systemd user unit `garrison-prod.service` (`Restart=always`, lingering on) | `bash scripts/garrison-instance.sh codex start` |
| code picks up | shell hot-reloads on save (`next dev`); fittings/operative only on `up` | ONLY at `npm run prod:redeploy` | on restart |
| tailnet | never published (hard rule); loopback-bound, so not reachable off-box at all | app at `https://dev-madrid.tail31efa.ts.net/` (443 -> 8777); fittings at `8400 + (port % 1000)` (e.g. drill 8096 -> :8496) | never published |

`npm start` starts the DEV instance (it is an alias of `npm run dev`), not
prod. Prod by hand is `npm run prod:start`; normally systemd owns it.

### Bind host (`GARRISON_BIND_HOST`)

One knob sets which interface the app AND every own-port fitting listen on.
**Every profile defaults to `127.0.0.1`.** This is a security boundary, not a
preference.

The Garrison shell is unauthenticated by design. `GET /api/vault/secrets`
returns every stored credential in cleartext and `PUT` overwrites them, with no
token and no audit trail. Loopback is the only thing between that endpoint and
whoever can route to the box.

**A `0.0.0.0` bind is not "loopback plus tailscale."** This box also carries:

| interface | address | who can reach it |
|---|---|---|
| `lo` | 127.0.0.1 | this box only |
| `tailscale0` | 100.88.165.46 | your tailnet devices |
| `ens4` | 10.204.0.4 | **every VM in the GCP project** (`default-allow-internal`, 10.128.0.0/9, tcp:0-65535) |
| `docker0` | 172.17.0.1 | **any container that runs here** |

The last two were verified reachable: a peer VM in the same VPC and a docker
container each read the full vault over plain http with one unauthenticated GET.
There is no host firewall closing them.

Prod reaches the tailnet the correct way and is the pattern to copy: it stays on
loopback while `tailscale serve` reverse-proxies the HTTPS tailnet address down
to it, so the listener is never exposed on the box's other NICs. Making dev
reachable off-box should be done the same way (a serve mapping on a dev-specific
serve-port range, so it cannot alias prod's), **not** by widening the bind.

A wide bind is still available as a deliberate, per-launch opt-in:

```bash
GARRISON_BIND_HOST_OVERRIDE=0.0.0.0 bash scripts/garrison-instance.sh dev start
```

It is never a default and never inherited - an ambient `GARRISON_BIND_HOST` in
the shell must not decide where prod listens. The launcher prints a warning
whenever the effective bind is not loopback.

Own-port fittings inherit `GARRISON_BIND_HOST` via `process.env` and each reads
it as a bind-host fallback, so the whole instance follows the one knob. A
per-fitting composition `bind_host` still overrides for one fitting when set to
a NON-loopback value (a loopback value is treated as the schema default and
defers to the instance knob).

View LINKS are independent of all this: the shell and renderers rebind loopback
URLs to whatever host the client reached Garrison on (`resolveViewUrl` /
`rewriteHostUrl`), so no fitting hands out a machine-local URL.

## Fitting port map (base 7xxx values; add the profile offset)

| fitting | base port | prod port | tailnet serve (prod) |
|---|---|---|---|
| monitor-default | 7077 | 8077 | 8477 |
| screen-share-default | 7079 | 8079 | 8479 |
| outpost-tailscale-host | 7082 | 8082 | 8482 |
| web-channel-default | 7083 | 8083 | 8483 |
| browser-default | 7084 | 8084 | 8484 |
| deepgram-voice | 7085 | 8085 | 8485 |
| dev-env | 7086 | 8086 | 8486 |
| orchestrator | 7087 | 8087 | 8487 |
| ports-default | 7088 | 8088 | 8488 |
| kanban-loop | 7089 | 8089 | 8489 |
| automations | 7090 | 8090 | 8490 |
| file-browser | 7091 | 8091 | 8491 |
| power-default | 7092 | 8092 | 8492 |
| improver | 7093 | 8093 | 8493 |
| garrison-assistant | 7095 | 8095 | 8495 |
| drill | 7096 | 8096 | 8496 |
| slack-channel (slack_port) | 9512 | 10512 | - |

Only fittings actually running get a `tailscale serve` mapping
(`scripts/tailnet-serve-views.mjs`, run by `prod:redeploy`; serve port =
`8400 + (localPort % 1000)`, bumped on collision, prod-only by a hard guard).

## How each environment runs

- **dev** - `scripts/garrison-instance.sh dev start` runs `next dev` on 7777
  plus the scheduler (7099) against `~/.garrison-dev` and an isolated Claude
  config dir. UI and API route edits hot-reload instantly. The operative and
  own-port fittings are separate long-lived processes: they only see new code
  when THEY restart (`up`, or the chokidar watcher in `dev(composition)` mode
  which reruns `apm install` + restart when a local-path fitting dep changes).
- **prod** - systemd user unit `garrison-prod.service` (Restart=always,
  WantedBy=default.target, user lingering on) runs
  `scripts/garrison-instance.sh prod start`, which serves the PREBUILT
  `.next-prod` via `next start` on 8777 and runs the scheduler on 8099. Never
  add a second scheduler unit. Only prod is published to the tailnet.

## When do changes reach prod? (and is mid-session editing safe?)

Editing, committing, and pushing garrison source changes NOTHING in running
prod: it serves a built artifact, and the operative + fittings are long-lived
processes holding the old code in memory. So working on garrison itself from
the prod web channel is safe mid-session - your edits cannot break the session
you are in.

The moment of truth is `npm run prod:redeploy`
(`scripts/garrison-redeploy.sh`), which is the ONLY sanctioned way changes
land: build -> down (stops the operative and its fittings on the old code) ->
`systemctl --user restart garrison-prod` -> vault unlock (keychain-sealed, no
passphrase - needed since account-pinned compositions fail a locked-vault up)
-> up (operative + all its fittings on the new code) -> tailnet serve mappings.
A failed build aborts with the last good build still serving.

That redeploy IS disruptive: the operative PTY is killed and restarted fresh
(the run-log ring buffer replays, but the Claude session state is gone) and
the web channel reconnects to a new operative session. So: edit and commit
freely at any time; run the redeploy at a moment you are willing to lose the
live operative session.

## When are fittings restarted?

| event | dev | prod |
|---|---|---|
| source edit / commit / push | shell hot-reloads; fittings untouched | nothing changes |
| `npm run prod:redeploy` | n/a | ALL: down (every own-port fitting stopped) then up (every one restarted on new code) |
| `up` | every own-port fitting started; running ones restarted if their env (gateway URL, composition id, config) changed | same |
| `down` | every own-port fitting stopped | same |
| fitting crashed / needs a solo code reload | `/api/fittings/[id]/start` / `restart` (recovery controls on `/fitting/<id>`), or a self-heal path (e.g. drill -> automations) | same |
| vault unlock | keyless-started vault-consuming fittings healed (restarted with secrets) | same |
| local-path fitting dep edited in `dev(composition)` mode | chokidar reruns `apm install` + restarts | n/a |

## One composition, one instance (hard rule recap)

All profiles resolve the SAME checkout-relative `compositions/<id>/`, so a
composition working tree can be up under only one instance at a time -
`.garrison/owner.json` enforces it. Prod normally owns `default`; a dev
operative must use a different composition. Starting the dev APP alongside
prod is always safe - the isolation is per composition tree, not per server.

## Mac editing with VM-only execution

When the source is edited on a Mac but the project runtime remains on
`dev-madrid`, use the temporary Git snapshot workflow in
[`REMOTE_MAC_WORKFLOW.md`](./REMOTE_MAC_WORKFLOW.md). `make remote-check`,
`make remote-build`, and `make remote-preview` run with an ephemeral home;
build and preview use the codex profile. None modifies this checkout or either
running service.
Never rsync an in-progress Mac worktree into the canonical VM directory: both
`garrison-prod.service` and `garrison-dev.service` execute from it.
