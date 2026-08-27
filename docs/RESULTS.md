# Results - the universal evidence entry point

Any session that tested something can report what it verified and get back a
drill-style report page with a durable link. A Claude Code work session, an
automation, an e2e run, another tool entirely - all report the same way, and
the report is readable on a phone the moment the session finishes.

**It executes nothing.** It renders no verdict of its own. The reporting
session decides what happened and what evidence fits its context; this only
records and renders it.

## Two surfaces, one behaviour

| | |
|---|---|
| **HTTP API** | `POST $GARRISON_APP_URL/api/results` and friends. The real surface. |
| **`drill-results` MCP** | A stdio wrapper over that API, bundled in the drill fitting. |

The HTTP API is primary and the MCP is a convenience, not a capability.
**Claude Code loads MCP servers only at session start**, so a session that was
already running when drill was equipped can never see the tools - it reports
with `curl` over the same API instead, with no restart and nothing lost. A live
session can also pick the tools up by restarting with `claude --resume`.

## Where it lives, and why

Ingest, storage and serving are all in the **Garrison app** (`:8777` on prod),
not in the drill fitting that bundles the MCP. That split is forced by one
requirement: *the link must keep working after the drill fitting and the MCP
stop*. Every own-port Fitting **and** the http-gateway are spawned by
`runner.up()` and killed by `down()` - a report hosted on either is a dead link
the moment the operative stops. The Next app is the only always-on HTTP surface
on the box (systemd `garrison-prod.service`, `Restart=always`) and it is what
the tailnet root resolves to, so it is also the only one reachable from the
phone.

The MCP is registered per instance: the launcher exports `GARRISON_CLAUDE_JSON`
per profile, so prod registers into the real `~/.claude.json` pointing at prod's
app, and dev registers into `~/.claude-garrison-dev/.claude.json` pointing at
dev's. The app URL is baked into the registration from the registering
instance's `GARRISON_APP_URL` - no port literal lives in the fitting.

## Lifecycle

Equipping the drill fitting registers the MCP at **user scope** (its setup hook
runs `scripts/register-results-mcp.mjs add`). Deselecting drill removes it on
the next `up`, through the standing-config ledger in `src/lib/coord-wiring.ts`
(`COORD_OWNERS.drill`) - the same mechanism the coordination Fittings use. A
plain operative `down` leaves the registration alone, deliberately: a direct
`claude` run in any repo should keep the tools.

Registration is never fatal to setup. A Claude config it cannot safely write
(corrupt JSON is never clobbered) logs and moves on; the HTTP API is unaffected.

## Provenance - the one thing that must not blur

Every report carries an `origin`, rendered as a full-width banner at the top of
the page:

- **`executed`** - produced by an actual drill run.
- **`reported`** - self-declared by a session through this API.

`reported` is the default and the only value the MCP can produce; `executed`
requires an explicit, deliberate claim on the HTTP API. The banner states the
distinction **in words** ("Nothing here was executed or checked by Drill"), not
only in a colour, so a reported run can never be mistaken for an executed one
by a reader who does not know the palette.

## The API

Every response carries `url` (the tailnet link when prod is published, else the
origin the call arrived on), `tailnetUrl`, `localUrl` and a relative `path`.

```bash
BASE=${GARRISON_APP_URL:-http://127.0.0.1:8777}

# 1. Open a run
RUN=$(curl -sX POST $BASE/api/results -H 'content-type: application/json' \
  -d '{"title":"Login flow after the session-fix","project":"/home/me/app","session":"'"$CLAUDE_SESSION_ID"'"}')
ID=$(echo "$RUN" | jq -r .runId)

# 2. Append steps as they happen (the page is live from here on)
curl -sX POST $BASE/api/results/$ID/steps -H 'content-type: application/json' \
  -d '{"name":"logs in with a valid password","status":"pass"}'
curl -sX POST $BASE/api/results/$ID/steps -H 'content-type: application/json' \
  -d '{"name":"rejects a bad password","status":"fail","logs":"expected 401, got 200"}'

# 3. Attach evidence - a file on this machine, multipart, or base64
curl -sX POST $BASE/api/results/$ID/media -H 'content-type: application/json' \
  -d '{"path":"/tmp/shot.png","caption":"the 200 that should have been a 401"}'
curl -sX POST $BASE/api/results/$ID/media -F file=@/tmp/run.webm

# 4. Finalize and print the link
curl -sX POST $BASE/api/results/$ID/finalize -H 'content-type: application/json' \
  -d '{"conclusion":"one real regression, reproduced twice"}' | jq -r .url
```

| Method | Path | |
|---|---|---|
| `POST` | `/api/results` | open a run |
| `GET` | `/api/results` | list runs (`?limit=`) |
| `POST` | `/api/results/<id>/steps` | append one step |
| `POST` | `/api/results/<id>/media` | attach media |
| `POST` | `/api/results/<id>/finalize` | close, return the link |
| `GET` | `/api/results/<id>` | the run JSON |
| `DELETE` | `/api/results/<id>` | drop the run and its media |
| `GET` | `/results/<id>` | the rendered report |
| `GET` | `/results/<id>/media/<name>` | media bytes (Range-capable) |
| `GET` | `/results` | the plain list of stored runs |

MCP tools mirror these one-for-one: `results_open_run`, `results_add_step`,
`results_attach_media`, `results_finalize_run`, `results_list_runs`. `runId` is
optional on all of them - the MCP process is one session, so the run that
session opened is the default target.

### What is mandatory

A run needs an id, a title, a source session, a start time, and ordered steps.
A step needs a name, a status (`pass` / `fail` / `skipped` / `info`) and a
timestamp. **Everything else is optional**: description, logs, screenshots,
video, arbitrary notes. A run of bare steps and statuses is a valid, complete
report.

Reporting is incremental. The static page is re-rendered on every append, so
the link returned by `results_open_run` is viewable mid-run and a refresh shows
the newest step. There is no live socket in v1, by design.

## Storage

```
$GARRISON_HOME/results/<runId>/
  run.json       the record
  report.html    the rendered page, rewritten on every mutation
  media/         images, videos, extracted keyframes
```

Records reference media by **relative name only**; bytes leave exclusively
through the confined `/results/<id>/media/<name>` route, realpath-checked. The
page references media root-relative, never as a machine-local absolute URL -
over the tailnet that would be both unreachable and mixed content.

## Media

- **Images** are stored as-is and rendered inline under their step.
- **Video** is capped and embedded with a standard player. On ingest a few
  keyframes are extracted and attached to the same step as images, so the
  report shows visual evidence *before* the video is played. Extraction
  degrades honestly: no ffmpeg, an unprobeable container or a failed decode
  yields zero frames plus a note saying why, and the video still attaches and
  plays.
- **All media is optional.**

Defaults, tunable by env because the cap is enforced where the bytes land (the
app), not in the reporting session:

| | default | env |
|---|---|---|
| video cap | 100 MB | `GARRISON_RESULTS_VIDEO_MAX_MB` |
| image / file cap | 25 MB | `GARRISON_RESULTS_MEDIA_MAX_MB` |
| keyframes per video | 4 | `GARRISON_RESULTS_KEYFRAMES` (`0` disables) |

100 MB holds several minutes of the Chrome screen recording that actually
arrives here; four frames read a flow at a glance without turning a step into a
contact sheet. Where a duration can be probed the frames are spread evenly
across the clip; a CDP webm often carries no duration in its header, so that
case samples at a fixed interval instead of giving up.

## Retention

**Keep everything.** Nothing is pruned automatically, ever - this is evidence,
and a report that silently loses its screenshots is worse than no report.
Cleanup is explicit:

```bash
curl -sX DELETE $BASE/api/results/<id>          # one run, media included
rm -rf ~/.garrison/results/<id>                 # the same thing by hand
find ~/.garrison/results -maxdepth 1 -mtime +90 -type d -exec rm -rf {} +   # age out
```

A run directory is self-contained, so deleting one can never damage another.

## Relationship to the Drill Book

The record is a **superset of the drillbook step format**. It carries the
page-shaped fields a `drills/pages/<id>.yml` has - `id`, `title`, `path`,
`mode: steps`, and steps of `{id, description, enabled, tags}` - plus the
evidence extensions (`status`, `at`, `logs`, `notes`, `media`, and the run-level
`origin`). A step reported with only a `name` gets that name as its
`description`, so a name-only step is still a valid page step.

That compatibility is what would let a viewer consume reported runs as flow
sources alongside the Book. **Note:** the "E2E Project Viewer" the original
brief refers to does not exist in this repo - nothing here reads these runs as
flow sources yet. The shape is in place for it; the consumer, and its
drillbook-wins-on-duplication rule, are not built.

## Out of scope in v1

Executing anything. Live streaming / websockets for mid-run updates.
Aggregation, dashboards, or history beyond the plain `/results` list. Any new
authentication layer - the reports inherit whatever the Garrison app already
enforces on its origin.
