# Decision note — tool bake-off

Decisions made after spikes on macOS (Darwin 24.6, ffmpeg 8.0, node 20, playwright-cli 0.1.6, vhs 0.11). Each was tested, not assumed.

## Browser capture + web captions → playwright-cli `page.screencast`
The installed playwright-cli fork ships a `screencast` API: `start({path,size})`, `showOverlay(html,{duration?})`, `showChapter()`, `stop()`. Captions are an in-page HUD rendered *inside* the recording.
- **Why over raw `recordVideo`**: recordVideo gives no programmatic overlays; we'd need a post-hoc burn-in.
- **Why over hand-rolled CDP screencast**: screencast already wraps CDP and adds the overlay layer.
- **Spike result**: overlays **survive full-page navigation natively** (the overlay layer is independent of page DOM). So per-beat captions = dispose + recreate at each beat; no `framenavigated` re-injection needed (the prototype's manual re-inject is unnecessary here).
- **Constraints learned**: `run-code` uses `--filename` (not `--file`); it runs in a locked VM (no `fs`/`require`/`process`, and `console.log` is not surfaced) so the script **returns** `JSON.stringify({offsets,results})` and we parse the `### Result` block; `file://` is blocked (serve fixtures over HTTP); `screenshot --filename` is sandboxed to the cwd.

## Beat timing → MEASURED, never inferred
The screencast script records `Date.now() - startTime` at each beat and returns it. `record.mjs` builds final-video timestamps from `cumulative ffprobe durations + measured intra-segment offset`. No assumed durations in the timestamp path. Spike: the home-beat midpoint landed exactly on the captioned frame → calibration offset ≈ 0 (configurable via `calibrationMs`).

## Terminal / logs / command output → rendered EVIDENCE panels (dropped VHS)
A screen recording of a shell being typed into is worthless as human proof and unusable in a public product walkthrough — this was the user's explicit objection. So there is **no terminal segment**: the `evidence` segment captures the content OFF-camera (read a file, run a command once and keep its stdout, tail a log) and renders only the **result** as a clean titled still — an editor/response/log viewer with the **proving line highlighted and annotated**. No PTY, no shell, no typing, no cursor.
- **Why a still, not a recording**: the content is static once captured; a held HTML→PNG panel (same path as title cards, `pngToClip`) is sharper, more legible, and website-grade, and it removes the whole VHS/ttyd stack (which was macOS-fragile — `Set Shell` broke the ttyd connection).
- **It's also a functional assert**: `highlight.match` must appear in the captured content or the beat fails honestly (red "ERROR" panel, run flagged) — the evidence layer of "two layers of truth", parallel to the browser `assert`.
- **Dropped dependency**: VHS + ttyd are no longer required (preflight no longer checks them). Legacy `type:"terminal"` storyboards auto-migrate to an evidence panel with a deprecation warning.
- **Honesty preserved**: the command still runs for real (off-camera) against the real system; only its *result* is shown, never a staged or pre-baked value. The test-runner ban now applies to an evidence `command`.

## Captions / cards / evidence → HTML→PNG, looped with ffmpeg
This ffmpeg build has **no `drawtext`** (no libfreetype). So all text is rendered as styled HTML → PNG via a playwright screenshot: title cards and evidence panels are full-frame PNGs looped to their hold duration (`pngToClip`); the browser segment paints its caption as an in-page HUD. Rendering text upstream is also prettier and keeps every surface (cards, panels, browser HUD) visually consistent.

## Compositor (Remotion) → NOT adopted
screencast gives rich in-page overlays and HTML→PNG title cards cover structure. Remotion would add a heavy React render toolchain for marginal intro/outro polish. Lightweight-first wins.

## Stitching → scale+pad to 1280×800 / 30fps / h264 yuv420p, concat, +faststart
Every segment is normalized to one canonical format, then concatenated with `-movflags +faststart` for mobile streaming. Handles mixed-resolution/codec inputs (browser webm vs looped-PNG stills) reliably.

## Frame sampling → targeted per-beat midpoint (primary) + optional interval
One frame per beat at its measured `tMid` is the primary check (legible, content-rich, low context cost). `--interval` adds ~10/min as a safety net only when localizing a failure, to avoid re-reading 20 frames per re-record.

## Verification → TWO gates: per-beat frames (precise) + claude-video holistic (story)
The per-beat midpoint frames prove each beat rendered the right caption+screen, but a video can pass every beat and still fail to *show the feature end-to-end* (skips the payoff, never shows a long op completing, dead stretches between beats). So a second gate watches the whole video: `review_video.mjs` drives the **claude-video (`/watch`) skill** to ingest `final.mp4` and the verifier answers a strict end-to-end rubric; a FAIL is treated like a failed beat (re-plan → re-record), shared retry ceiling.
- **Why claude-video, not a hand-rolled sampler**: the user chose it; it does duration-aware frame density + transcript and is maintained separately. Our videos are silent, so `--no-whisper` (no Groq/OpenAI key needed). It's a **hard preflight requirement** — the holistic gate is not optional.
- **Why not let `/watch` self-judge headlessly**: claude-video prepares frames for Claude's multimodal Read; the judgment is the verifier's. The helper just locates the tool, ingests with the right flags, and prints the rubric the verifier applies.

## Long operations → ONE live session, then timelapse OR cut (never fake)
A build/generation that takes minutes can't be a teaser and can't be dead footage. Browser segments gained session continuity so the real op runs continuously across them:
- `continue: true` reuses the page the previous segment left open (playwright-cli keeps the session between `run-code` calls — we just skip the close/open/goto). `record.mjs` keeps the browser open across a segment iff the next browser segment continues.
- **Timelapse** (`speed: n` + beat `holdUntil`): record the real progress, speed the whole segment with ffmpeg `setpts`, and **scale the measured offsets by `n`** so the manifest stays truthful. `t0` is now sampled at `screencast.start` (not script top) so a long `waitBefore` can't skew offsets.
- **Cut** (`waitBefore`): wait for completion before the camera rolls (unrecorded), bridged by a "≈ N min later" title card.
- Both are honest: real footage of the real run, only the boring middle compressed or skipped — never a pre-baked result substituted for the live one.

## Distribution → static Range/206 server bound to the Tailscale IP
`serve.mjs` implements HTTP range (206) so phones scrub instead of downloading, binds to `tailscale ip -4` (tailnet-only, not LAN/public), and renders a gallery of past runs (newest first; flagged/verified badges). `tailscale serve` is the optional HTTPS-hostname upgrade.
- **Gallery is a client SPA over a JSON API.** `serve.mjs` exposes `GET /api/runs` (each run enriched with chapter markers from `manifest.beats` and the mp4 byte size) and serves `gallery.html`, which renders entirely client-side: live search, sort, project/status filters, group-by-project toggle, and an in-page fullscreen player with arrow-key/swipe navigation between runs and seekable chapter markers. The page replaces the old "card is an `<a>` to the raw mp4" behavior; the raw `/<project>/.../final.mp4` links still resolve unchanged.
- **Thumbnails → lazy ffmpeg JPEGs, cached on disk.** `GET /thumb/<rel>` extracts one frame (first real content beat, else ~30% in) at 480px via ffmpeg and caches it as `thumb.jpg` beside `final.mp4`; a 4-slot semaphore + in-flight dedupe keeps a cold 80-run load from forking 80 ffmpegs. The extracted per-beat PNGs are 140–470 KB each — too heavy to use directly as 80 card thumbnails — so a downscaled JPEG (~20 KB) is generated instead. ffmpeg is already a hard dependency, so no new requirement.
- **Lightbox → hand-rolled, not a CDN library.** The requested fullscreen-in-tab + arrow/swipe behavior is ~150 lines of vanilla JS. A third-party lightbox (GLightbox/PhotoSwipe/Swiper) would add a CDN dependency that breaks when the tailnet has no internet and would fight us on video lifecycle — against the lightweight-first, self-contained posture of the rest of the tool.

## Concurrent runs → per-run playwright-cli daemon namespace (isolate, don't share)
Recording from two sessions/projects at once used to corrupt both: they shared one browser daemon and stomped each other.
- **Root cause (verified, not assumed):** playwright-cli keys its session registry by a *workspace* hash from walking up cwd for a `.playwright` dir. Our runs execute under `~/.walkthrough/runs/...` (no such dir), so **every run on the machine collapses to the same fallback hash and the same `default` session** (`sha1(playwright-core packageRoot)` = `a7b8c2545f595059` here). Then (1) a fresh run's `open default` *stops* the existing `default` daemon — killing the other run's browser; and (2) the between-segment `close-all` is **workspace-scoped, not session-scoped** — it stops *every* session under that shared hash. A named session via `-s=` alone does **not** help: `close-all` still enumerates the whole workspace. Reproduced live: run B's `open`+`close-all` left run A at "browser 'default' is not open" mid-recording.
- **Fix:** `util.pw` now derives a deterministic per-run scope from `workDir` and sets **both** isolation levers on every `playwright-cli` call: `PLAYWRIGHT_DAEMON_SESSION_DIR=<tmp>/wt-pw/<id>` (scopes the registry → `close-all`, plus session/profile files) **and** a unique session name `wt<id>` (scopes the daemon socket, which is keyed `<workspaceHash>-<session>`). Either alone is insufficient — the socket is keyed by session name, the registry/close-all by the daemon dir. The id is `sha1(workDir).slice(0,8)`, kept short because the macOS unix-socket path is length-bounded (~104B; measured 97–99B in tmpdir).
- **Render lane:** title-card / caption-bar screenshots run on a separate session (`wtr<id>`) and `close` themselves after each shot, instead of the old workspace-wide `close-all` — so a render can never tear down a kept-open `continue` recording session, and nothing lingers.
- **Never `kill-all` during recording:** it is a machine-wide `ps`-grep SIGKILL of all playwright daemons (cross-workspace) — it would kill every concurrent run. Scoped `close` is the only teardown used.
- **Spike result:** with both levers set, run B's `open`/`render`/`close-all` left run A fully alive and executable (`run-code` returned `A-ALIVE-42`); the production `default` daemon was untouched; no orphan daemons.

## Limits (state these in any handover)
- **Flow selection** is heuristic and improves only via `.walkthrough/notes.md`. It will sometimes pick the wrong flow until corrected.
- **Vision verification** confirms communication truth (caption + screen), not business correctness — that is why functional Playwright asserts (and evidence `highlight.match`) are kept.
- **Evidence panels are stills**, not live footage: they prove a captured state (a file, a response, a log line), not motion. For something that must be seen *happening* (a build progressing, a stream updating), record the real browser flow (timelapse/continue), not a panel.
