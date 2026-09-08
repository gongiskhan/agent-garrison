# G3-ui + G4 evidence

Talk UI: the Sessions rail section, the owned-shell panel, the external session view, the New
shell modal, and the CSS to back all four. Verified live against `https://dev-madrid.tail31efa.ts.net`.

## Static checks

```
$ npx tsc --noEmit
(clean, exit 0)

$ npm run lint
✔ No ESLint warnings or errors

$ npx vitest run tests/talk-mesh-sessions.test.ts tests/talk-shell-binding.test.ts \
    tests/talk-shell-origin.test.ts tests/talk-transcript-formats.test.ts \
    tests/shells-listers.test.ts tests/shells-hooks-install.test.ts \
    tests/shells-origin-guard.test.ts tests/mesh-proxy.test.ts tests/vocabulary.test.ts \
    tests/talk-rail-rows.test.ts tests/web-channel-rail-order.test.ts \
    tests/remote-shell-local-transport.test.ts tests/remote-shell-runtimes.test.ts \
    tests/remote-shell-runtime.test.ts tests/remote-shell-storm.test.ts \
    tests/remote-shell-multisession.test.ts tests/remote-shell-exec-lane.test.ts \
    tests/dev-env-claude-sessions.test.ts tests/dev-env.test.ts tests/instance-isolation.test.ts \
    tests/state-client-drift.test.ts
Test Files  21 passed (21)
     Tests  229 passed (229)
```

`tests/talk-rail-rows.test.ts` is new (6 tests) - pins `visibleSessionRows`, the filter app.tsx (badge
count) and sessions-rail.tsx (row list) both call so a session already bound to a thread, already
recognised as an open conversation, or already claimed by a Kanban card never double-renders.
`tests/vocabulary.test.ts` gained two whole-file `SESSION_IS_THE_RUNTIME` entries for
`sessions-rail.tsx` and `session-view.tsx` - both are legitimately about runtime CLI/tmux sessions,
matching the existing `remote-shell-workbench.tsx`/`shells-modal.tsx` pattern.

## Deploy

App-only change (`packages/talk/ui/**`, `tests/vocabulary.test.ts`) - no `fittings/seed/**`,
`packages/claude-pty`, or `compositions/*/apm.yml` touched, so `npm run node:reload` (not redeploy)
per CLAUDE.md's restart discipline.

```
$ npm run node:reload
...
[reload] restarting garrison-prod.service (systemd)
[reload] waiting for http://127.0.0.1:8777
[reload] starting operative (default) - fast path when the composition is unchanged
[reload] done - app reloaded, operative running
```

```
$ curl -sf http://127.0.0.1:8777/api/mesh/self   # 200
$ curl -sf http://127.0.0.1:8098/health          # 200
$ curl -sf http://127.0.0.1:8777/api/sessions | jq '.rows[0].id'
"3997a816-32a5-4dbe-8113-1243461092df"           # this very session, status "working"
```

## Live browser verification (claude-in-chrome, against the tailnet origin, never localhost)

Desktop, 1440x900 (`https://dev-madrid.tail31efa.ts.net/talk`):

- Expanded the rail (`wc.sessions.open` in localStorage controls the desktop rail-vs-42px-collapse
  state; it started collapsed on this profile). The **Sessions** section renders above the regular
  conversation groups, brass left-border header, count badge (50, drifting live), one **DEV-MADRID**
  node sub-head with its accent dot and its own count.
- Rows show the runtime badge (CLAUDE / SHELL), a project chip, a status word (WORKING / IDLE), and a
  relative "when". The top row is this very Claude Code session - `/home/ggomes/dev/garrison`, CLAUDE,
  garrison, **WORKING**, 1h ago - confirmed against `GET /api/sessions` returning the same session id
  with `status: "working"`. Below it, real `csg` tmux sessions the listers picked up live: `pnmui-monorepo
  #2/#3/#4`, `ui-sms-ws`, `CSG work`, all `SHELL` / IDLE / dated 8/26/2026 - exactly the sessions the
  research appendix recorded living on that box.
- Clicked the top (WORKING) row -> `ExternalSessionView` opened: header chips `CLAUDE CODE` / `dev-madrid`
  / `garrison` / title `/home/ggomes/dev/garrison` / subline "Running in another terminal on dev-madrid" /
  Close; actions row "Continue in a shell" and "Copy resume command" (both enabled - `resumable: true`,
  `resumeCommand` present); body streamed the session's own live transcript in real time (network: `GET
  /api/sessions/3997a816-.../stream` -> 200) - literally this conversation rendering itself, which also
  proves SessionStream's SSE parsing is wired correctly end to end.
- "Show ended" toggle: clicking it revealed 20 previously-hidden ended rows (`.wc-thread--ended`), proving
  the default-hide-ended / reveal-on-demand behaviour works.
- "+ New" -> "New shell..." opened `NewShellModal`: node segmented control (dev-madrid, selected + the
  three other mesh nodes, each with its accent dot), runtime segmented control (Shell selected; Claude,
  Codex, Gemini enabled; **Cursor correctly disabled** - dev-madrid has no `cursor-agent`, matching the
  G0 research), project picker. Did not press Start (would spawn a real tmux session + a new Conversation
  thread on the live box - out of scope for a static-verification pass; `POST /sessions` against a real
  local transport is already covered live by `tests/remote-shell-local-transport.test.ts`'s "creates a
  real session on the dedicated socket" case). Cancelled the modal.
- Screenshot: `desktop-rail-session-newshell.jpg` (rail + external session view header + New shell modal,
  all in one frame).
- Console: no application errors (`read_console_messages` pattern `error|Error|warn|Warn` returned only
  an unrelated MetaMask extension warning). Network: every `/api/*` request in the trace returned 200,
  including `/api/sessions` and `/api/sessions/<id>/stream`.

Mobile viewport:

- The browser-automation window in this environment would not honour a true 390x844 resize (`resize_window`
  changed `window.outerWidth/Height` but left `window.innerWidth/Height` at the desktop size on the first
  tab; a fresh tab landed at 500x701 CSS px instead of 390x844 - an environment/tooling limitation, not
  something under app control). At that narrower width the drawer opened correctly
  (`wc-shell wc-shell--open`), `rail-section-sessions` and `rail-show-ended` were present, and
  `document.body.scrollWidth === document.body.clientWidth` (no horizontal page scroll).
- The screenshot JPEG at that size showed row text apparently clipped from the left ("garrison" reading as
  "son", "WORKING" as "NG"). Inspected the live DOM instead of trusting the image:
  `getBoundingClientRect()`/`getComputedStyle()` on `.wc-sidebar`, `.wc-thread-open`, `.wc-thread-main`,
  and `.wc-thread-title` all showed correct position/width/`overflow:hidden`/`direction:ltr`/
  `text-align:left`, and `title.textContent` was the full untruncated string
  ("/home/ggomes/dev/ekoa-dev"). The same clipped appearance affected pre-existing conversation rows
  (`ekoa-dev`, `ekoa-code`, `28-palavras`) identically, i.e. rows this gate never touched - so this reads
  as a screenshot-capture/scaling artifact of the automation tool at this non-standard viewport width, not
  a real rendering defect. Left as a note rather than a fix, since the DOM evidence contradicts the image
  and chasing a tooling artifact further risks a rabbit hole; true pixel-perfect 390x844 QA (8px grid,
  contrast measurement, safe-area) is explicitly the E2E phase's job (run protocol STOP 4, Opus) and
  should re-check this with a fresh eye/tooling attempt.

## Known deviation from the plan's literal G4 text

The plan's G4 slice says `remote-shell-workbench.tsx` gains a `mode="shell"` prop. Implemented instead as
a separate `packages/talk/ui/shell-panel.tsx` (`ShellPanel`) reusing the same deck CSS classes
(`.wc-wb-head`, `.wc-wb-lamp*`, `.wc-wb-title`, `.wc-wb-crumb`, `.wc-wb-reattach`) plus a new
`shell-composer.tsx`. Reason: `remote-shell-workbench.tsx` carries the seam/ledger/delegate machinery for
the OLDER remote-shell thread shape; grafting a second mode onto it risked destabilising that path for no
benefit, where a small sibling component carries zero risk to the existing surface and shares its visual
language exactly. Noted here so a reviewer does not read this as a missed instruction.
