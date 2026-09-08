# Instances - ports, lifecycles, and how changes reach each environment

The single source of truth for port math is `src/lib/instance-profile.ts`
(mirrored by `scripts/garrison-instance.sh`). The committed compositions carry
ONE port map (the 8xxx family - the values the always-on instance has served
since the prod profile existed); every instance is that map plus a fixed
offset. The 2026-08-24 mesh re-axis renamed `prod` to `node` (offset 0, one
per machine) and moved only the sandboxes: dev to +10000, codex to +20000.
`prod` survives one release as a spelled-out alias for `node`. This doc is the
operational companion: what runs where, how each instance is started, and
when code changes actually take effect.

## Instance table

| | node (alias `prod`) | dev | codex |
|---|---|---|---|
| offset | 0 | +10000 | +20000 |
| app (Next) | 127.0.0.1:8777 | 127.0.0.1:18777 | 127.0.0.1:28777 |
| gateway (http-gateway) | 5777 | 15777 | 25777 |
| scheduler health | 8099 | 18099 | 28099 |
| fittings | 80xx | 180xx | 280xx |
| outpost WS bridge (`GARRISON_OUTPOST_PORT`) | 4702 - DEPRECATED, nothing binds it since the mesh | 14702 | 24702 |
| `GARRISON_HOME` | `~/.garrison` | `~/.garrison-dev` | `~/.garrison-codex` |
| Claude config | the REAL `~/.claude` (`CLAUDE_CONFIG_DIR` unset) | `~/.claude-garrison-dev` (via `CLAUDE_CONFIG_DIR`) | `~/.claude-garrison-codex` |
| Next dist dir | `.next-prod` (`next start`, prebuilt) | `.next` (`next dev`) | `.next` |
| started by | systemd user unit `garrison-prod.service` on Linux (`Restart=always`, lingering on); launchd on the Macs | `npm run dev` | `bash scripts/garrison-instance.sh codex start` |
| code picks up | ONLY at `npm run node:redeploy` (`node:reload` for app-only changes) | shell hot-reloads on save (`next dev`); fittings/session only on `up` | on restart |
| tailnet | app at `https://<node>.tail31efa.ts.net/` (443 -> 8777); fittings at `8400 + (port % 1000)` (e.g. drill 8096 -> :8496), the same serve port on every node | never published (hard rule); loopback-bound, so not reachable off-box at all | never published |

`npm start` starts the DEV instance (it is an alias of `npm run dev`), not
the node. The node by hand is `npm run prod:start`; normally systemd/launchd
owns it.

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

## Fitting port map (committed 8xxx values; add the profile offset)

Every own-port fitting declares its `default_port` in its `apm.yml` and the
default composition pins the same number in `config.port`, so the committed
value IS the node port. Sandboxes add their offset.

| fitting | node port | dev (+10000) | codex (+20000) | tailnet serve (node only) |
|---|---|---|---|---|
| monitor-default | 8077 | 18077 | 28077 | 8477 |
| screen-share-default | 8079 | 18079 | 28079 | 8479 |
| email-channel | 8081 | 18081 | 28081 | 8481 |
| web-channel-default | 8083 | 18083 | 28083 | 8483 |
| browser-default | 8084 | 18084 | 28084 | 8484 |
| dev-env | 8086 | 18086 | 28086 | 8486 |
| whatsapp-web | 8087 | 18087 | 28087 | 8487 |
| ports-default | 8088 | 18088 | 28088 | 8488 |
| kanban-loop | 8089 | 18089 | 28089 | 8489 |
| automations | 8090 | 18090 | 28090 | 8490 |
| file-browser | 8091 | 18091 | 28091 | 8491 |
| power-default | 8092 | 18092 | 28092 | 8492 |
| improver | 8093 | 18093 | 28093 | 8493 |
| omi-channel | 8094 | 18094 | 28094 | 8494 |
| garrison-assistant | 8095 | 18095 | 28095 | 8495 |
| drill | 8096 | 18096 | 28096 | 8496 |
| capture-service | 8097 | 18097 | 28097 | 8497 |
| remote-shell-runtime | 8098 | 18098 | 28098 | 8498 |
| slack-channel (`slack_port`) | 9512 | 19512 | 29512 | - |

`deepgram-voice` (8085) was retired 2026-09-02; capture-service is the voice
layer. The Orchestrator is not an own-port fitting and binds nothing (its
manifest declares no port key and `config_schema: []`); the `port: 8087` the
compositions used to carry under its selection was a phantom and is gone -
8087 is whatsapp-web's, as its `default_port` and the composition say.
`web-channel-default` is unstationed by default (Conversations is served by
the shell at `/talk`); its row stays until the operator triggers the removal.

Only fittings actually running get a `tailscale serve` mapping
(`scripts/tailnet-serve-views.mjs`, run by `node:redeploy`; serve port =
`8400 + (localPort % 1000)`, node-only by a hard guard - the script refuses a
sandbox shell and a machine with no `~/.garrison/node.json`). With every node
at offset 0 the serve port is a mesh invariant: same fitting, same serve port
on every machine (`tests/mesh-serve-ports.test.ts`).

## How each environment runs

- **dev** - `scripts/garrison-instance.sh dev start` runs `next dev` on 18777
  plus the scheduler (18099) against `~/.garrison-dev` and an isolated Claude
  config dir. UI and API route edits hot-reload instantly. The session and
  own-port fittings are separate long-lived processes: they only see new code
  when THEY restart (`up`, or the chokidar watcher in `dev(composition)` mode
  which reruns `apm install` + restart when a local-path fitting dep changes).
- **node** (alias `prod`) - the systemd user unit `garrison-prod.service`
  (Restart=always, WantedBy=default.target, user lingering on) on Linux, or the
  launchd agent on the Macs, runs `scripts/garrison-instance.sh prod start`,
  which serves the PREBUILT `.next-prod` via `next start` on 8777 and runs the
  scheduler on 8099. Never add a second scheduler unit. Only the node is
  published to the tailnet.

## When do changes reach prod? (and is mid-session editing safe?)

Editing, committing, and pushing garrison source changes NOTHING in running
prod: it serves a built artifact, and the session + fittings are long-lived
processes holding the old code in memory. So working on garrison itself from
the prod web channel is safe mid-session - your edits cannot break the session
you are in.

The moment of truth is `npm run prod:redeploy`
(`scripts/garrison-redeploy.sh`), which is the ONLY sanctioned way changes
land: build -> down (stops the session and its fittings on the old code) ->
`systemctl --user restart garrison-prod` -> vault unlock (keychain-sealed, no
passphrase - needed since account-pinned compositions fail a locked-vault up)
-> up (session + all its fittings on the new code) -> tailnet serve mappings.
A failed build aborts with the last good build still serving.

That redeploy IS disruptive: the session PTY is killed and restarted fresh
(the run-log ring buffer replays, but the Claude session state is gone) and
the web channel reconnects to a new session. So: edit and commit
freely at any time; run the redeploy at a moment you are willing to lose the
live session.

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
dev instance must use a different composition. Starting the dev APP alongside
prod is always safe - the isolation is per composition tree, not per server.

## Installer rules carried over from the retired Mac remote workflow

The Mac-edits-here / VM-executes-there workflow (`scripts/remote-dev.sh`, the
`make remote-*` targets, `docs/REMOTE_MAC_WORKFLOW.md`) retired on 2026-08-24
with the outposts: on the mesh a Mac runs its own full Garrison node, so there
is nothing to shuttle. Two of its rules were load-bearing and survive as
**installer rules** for `scripts/install-node.sh`:

- **Symlink refusal.** Before adopting an existing checkout, refuse when the
  target path (or any component of it) is a symlink. `~/dev` and `~/Projects`
  are symlinked to each other on these machines, so the same repository resolves
  through two paths; adopting through the link installs a node whose
  `GARRISON_HOME`, service unit and git remote disagree about where it lives.
- **Never sync into a live checkout.** No installer or convergence step may
  rsync a working tree over a checkout a service is executing from — on Linux
  `garrison-node.service` and `garrison-dev.service` both run out of it, and on
  a Mac the launchd node agent does. Code moves between nodes through git and
  nothing else.
