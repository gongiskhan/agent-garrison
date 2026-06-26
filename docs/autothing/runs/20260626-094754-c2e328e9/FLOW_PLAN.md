# FLOW_PLAN — Web-Channel UI overhaul

Run: `20260626-094754-c2e328e9`
Brief: Make the web-channel Fitting UI **much better** — (1) restyle to Garrison's
look-and-feel (via huashu-design), (2) richer output rendering + far more visible
"working" feedback, modeled on leading chatbots (Claude).

## Key facts (from exploration — anchor the build on these)

- The served UI is the **shared** `ClaudeChat` component (`packages/claude-chat/src/ClaudeChat.tsx`,
  `.cc-*` classes). The web-channel wrapper is `fittings/seed/web-channel-default/ui/main.tsx`
  rendering `<ClaudeChat title="Operative" features={{ voice:true }} … />`.
- **Root cause of "doesn't match Garrison":** web-channel passes **no `theme` feature**, so
  `.cc-root` carries no `data-theme` → it falls back to the **dark GitHub palette** (`--cc-bg:#0d1117`…).
  The cream tokens in `ui/styles.css` only style **legacy `.app/.bubble/.voice-*`** classes that are
  **not rendered** (those belong to the unmounted `ui/legacy-voice.tsx`). So today the web-channel is a
  dark chat that ignores Garrison entirely.
- **Shared-component constraint:** `ClaudeChat.tsx` + `claude-chat.css` are shared with **dev-env**.
  The base `.cc-root` tokens are also used by dev-env's **dark** mode (no `[data-theme="dark"]` block).
  → Do **NOT** repurpose the base tokens. dev-env opts into theme via `data-theme="light|dark"`.
- **Scoping lever:** `ui/build.mjs` concatenates web-channel `styles.css` **after** `claude-chat.css`
  into `dist/web-channel.css`; dev-env never loads `styles.css`. So **overriding `.cc-*` in
  `styles.css` restyles ONLY web-channel** — zero risk to dev-env. This is the restyle mechanism.
- Garrison design tokens (`src/app/globals.css`): paper `#fbf8f1` / paper-2 `#f4ede0` / ink `#18211c`
  / sage-2 `#3d6249` / rule `#d6cdba` / mute `#66695f` / alarm `#9b362d` / brass-2 `#d8a82e`.
  Fonts (next/font): **Inter** (UI), **Source Serif 4** (display/headings), **JetBrains Mono** (mono).
- **Test harness already exists:** `tests/e2e/web-channel-chat.spec.ts` boots a **fake gateway** +
  the real web-channel server and drives the page. This is the committed re-runnable e2e gate to
  extend (the fake gateway can stream `assistant` chunks + `turn` events to exercise feedback/output).
- Two transports: default **PTY** (`/api/claude/*`, has status rows) and **orchestrator**
  (`/api/chat`, no status rows). New feedback UI must degrade gracefully for both.
- Constraints: web-channel stays **generic** (no kanban/dev-env knowledge); don't break the
  context/mode/kickoff path; no emoji in UI (SVG/text only).

## Slices (run SERIALLY — both touch `ui/styles.css` + the chat; shared runtime: one build/serve/recorder, one codex at a time)

### S1 — Garrison look-and-feel restyle (web-channel-scoped) · kind: ui · route: `/`
Drive the visual direction with **huashu-design** (chat surface embodying Garrison's editorial,
paper/ink, serif-headline aesthetic), then implement in CSS only — no behavior change.
- `fittings/seed/web-channel-default/ui/index.html` — add Garrison font `<link>`s (Inter, Source Serif 4,
  JetBrains Mono) + viewport/theme-color meta; keep system fallbacks.
- `fittings/seed/web-channel-default/ui/styles.css` — **rewrite**: override the `.cc-root` token palette
  to Garrison's paper/ink/sage/rule/mute/alarm; set font tokens; polish every chat element —
  `.cc-header` (+ `.cc-title` in Source Serif), conn dot, `.cc-scroll`, `.cc-empty` welcome,
  `.cc-user`/`.cc-assistant` bubbles, `.cc-md` typography + inline/block code, `.cc-statusstrip`,
  `.cc-modes`, `.cc-toolbar`/`.cc-chip`, `.cc-composer`/`.cc-input`/`.cc-send`/`.cc-stop`, `.cc-slashmenu`
  + badges, `.cc-mic`/`.cc-speak`. Remove dead legacy `.app/.bubble/.voice-*` rules. Mobile-first,
  max-width ~760px, safe-area insets.
- **Acceptance:** page renders in Garrison cream/paper with Inter body + Source Serif title + JetBrains
  mono code; header/bubbles/composer/status/modes/slashmenu visually match Garrison; clean on
  390px mobile + desktop. e2e asserts `.cc-root` computed `background-color` ≈ paper `#fbf8f1` and the
  chrome renders; design-audit clean; walkthrough video.
- status: pending

### S2 — Rich output + visible working feedback (shared `claude-chat`, additive) · kind: mixed · route: `/`
Make output richer and the agent's "working" state obvious, like Claude. All additive — dev-env benefits
and must not regress.
- `packages/claude-chat/src/ClaudeChat.tsx`:
  - **Working indicator:** replace the bare `…` (`.cc-typing`) with a polished animated indicator shown
    while `busy` — animated dots/shimmer + label + a **live elapsed timer** (counts up while busy); when
    PTY status rows carry activity, surface a compact hint. Degrades to plain "Working…" + elapsed for the
    orchestrator transport (no status). Streaming cursor polish once text starts.
  - **Code blocks:** add a `marked` `code` renderer → **syntax highlighting** (add `highlight.js`
    if absent; curated common langs), a **language label**, and a **per-block copy** button. Keep
    output safe (escape; highlight.js escapes).
  - **Per-message copy:** copy-on-hover button on completed assistant messages.
  - **Jump-to-latest:** show a "scroll to latest" affordance when the user has scrolled up and new
    content arrives (uses existing `pinnedRef`).
- `packages/claude-chat/src/claude-chat.css` — style the new elements for both base(dark) + `[data-theme=light]`.
- `fittings/seed/web-channel-default/ui/styles.css` — theme the new elements for the Garrison cream palette.
- `tests/e2e/web-channel-chat.spec.ts` — extend the fake gateway to emit `turn{active:true}` + streamed
  `assistant` chunks containing a fenced code block; assert: working indicator visible while busy +
  elapsed shown; code block highlighted + copy button present & copies; per-message copy works.
- `package.json` — add `highlight.js` only if not already present.
- **Acceptance:** while busy a clearly visible animated working indicator with elapsed time shows (both
  transports); code blocks are highlighted with a working copy button + lang label; per-message copy works;
  **dev-env not regressed** (its build + existing e2e still pass). design-audit clean; walkthrough video.
- status: pending

## Out of scope
- No server/transport protocol changes; no gateway changes; no new capability kinds.
- Don't touch the operative test interface or dev-env behavior (only additive shared-component changes,
  verified non-regressing).
- legacy-voice.tsx stays as-is (unmounted); its dead CSS is removed from web-channel styles.css only.

## Verification (whole run)
- `npm run typecheck`, `npm test` (vitest), `node fittings/seed/web-channel-default/ui/build.mjs` exit 0.
- Playwright: extended `tests/e2e/web-channel-chat.spec.ts` green (incl. the 390x844 mobile project).
- Per slice: committed e2e assertion + clean build/typecheck/lint + same-model review + Codex
  review(approve) + Codex Playwright pass + design-audit (huashu/frontend-design) + verified walkthrough video.
