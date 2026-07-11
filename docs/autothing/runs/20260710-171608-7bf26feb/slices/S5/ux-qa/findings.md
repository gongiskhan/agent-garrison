# ux-qa — S5 (GARRISON-FLOW-V2)

**Gate:** `garrison-ux-qa` (the S5 deliverable), executed for real against a running UI.
**Target UI:** the **kanban-loop board** (`fittings/seed/kanban-loop`), served from a
**sandboxed** instance — isolated `GARRISON_HOME` / `GARRISON_KANBAN_DIR` / `GARRISON_POLICY_PATH`
under the session scratchpad, ephemeral port, 11 seeded cards (one in every list so each
list state renders). The live `~/.garrison` board and its status file were never touched
(verified: the live `~/.garrison/ui-fittings/kanban-loop.json` mtime is unchanged).
**Policy:** sandbox `policy.json` with `coordination.enabled: true`, `uxQa.severityThreshold: major`.
**Viewports:** desktop 1440x900, mobile 390x844, plus 375px / 768px / 1024px responsive checks.
**Date:** 2026-07-11.

**Verdict: `issues(11)`** — 6 findings at or above the `major` threshold (1 blocker, 5 major),
4 minor, 1 note. Under the loop-back rule a slice carrying these findings returns to
`garrison-implement`.

> **Scope note (read before acting on the findings).** The lead directed this gate at the
> kanban-loop board UI. That board is not S5's own code — S5 shipped the ux-qa skill, the
> policy phase and the validator check. So these findings describe the **board**, not the S5
> diff, and the loop-back they would trigger belongs to whichever slice owns the board surface
> (S6). They are recorded here because this is where the gate was exercised. The mechanical
> loop-back rule itself is proven separately in `loopback-proof.txt`.

Measurements are mechanical, taken in-page with Playwright: contrast is computed from the
actual composited foreground/background (`getComputedStyle` + alpha compositing, WCAG relative
luminance), tap targets from `getBoundingClientRect()` in CSS px, overflow from `scrollWidth`
vs `clientWidth`.

---

## Findings

### uxqa-1 — [blocker] Touch targets on the phone-first board are all below the 44px comfort target
- **section:** Accessibility basics
- **screenshot:** `screenshots/mobile-board.png`
- **what + where:** At 390x844, every interactive control on the board is below the 44px mobile
  comfort target. Measured: the per-list **config gear** (`button.gear`, all 13 lists) is
  **28x28**; every card action — **Advance / Move / Watch / Open / Run / Discuss**
  (`.card .btns .btn`) — is **31px tall** (Advance 99.2x31, Move 81.2x31, Watch 85.2x31,
  Open 277.6x31, Run 80.5x31). The gear is the *only* affordance for list configuration.
  The WCAG 2.2 AA floor of 24x24 is **met** — nothing is below 24px, so this is not a WCAG
  violation; the escalation to blocker comes from the checklist's touch-surface clause
  ("blocker on touch surfaces below ~44px comfort target") and from the board's own stated
  goal: `apm.yml` / `scripts/server.mjs` describe it as the "responsive, **phone-first** board
  UI", and the S6 acceptance requires it to be "iPhone-usable". On its own terms it fails.
- **fix:** In `ui/styles.css`, at the mobile breakpoint (`@media (max-width: 600px)`) set
  `.card .btns .btn { min-height: 44px; }` and `.list .lname .gear { width: 44px; height: 44px; }`
  (keep the 28px glyph, grow the hit area with padding). Desktop sizes can stay as they are.

### uxqa-2 — [major] Modal sheets never take focus; Tab walks the board behind the overlay
- **section:** Accessibility basics
- **screenshot:** `screenshots/desktop-card-detail.png`
- **what + where:** Open a card ("Open" -> the card-detail sheet). The sheet renders as an
  overlay above a dimmed board, but focus is never moved into it. Pressing Tab 12 times from
  the open sheet lands, in order, on **New card, Configure Backlog, Configure To Do, Advance,
  Move, Watch, Open, Advance, Move, Watch, Open, Configure Discuss** — every one a control on
  the board *behind* the overlay (`sheet.contains(activeElement) === false` for all 12 stops).
  A keyboard user who opens a card can never reach its Close button, "Abandon & prepare revert"
  or "Delete card"; meanwhile the focus ring is drawn on controls that are visually obscured.
  Order is illogical and focus is effectively invisible.
- **fix:** In the shared `Sheet` component (`ui/main.tsx`): add `role="dialog"` +
  `aria-modal="true"`, move focus to the sheet container (`tabIndex={-1}`) or its Close button
  on mount, cycle Tab/Shift+Tab within the sheet, restore focus to the invoking control on
  close, and mark the board `inert` (or `aria-hidden="true"`) while a sheet is open. Escape
  already closes the sheet — keep that.

### uxqa-3 — [major] Five text styles fail 4.5:1 — the brass/warn tokens on cream
- **section:** Accessibility basics
- **screenshot:** `screenshots/desktop-empty-lists.png` (list titles), `screenshots/desktop-board.png` (chips, waiting callout)
- **what + where:** Measured against their actual composited backgrounds:

  | element | style | fg / bg | measured | needs |
  |---|---|---|---|---|
  | `.chip.goal` ("goalMode", Plan card) | 10px / 400 | `#b4862a` on `#f6ecd0` | **2.79:1** | 4.5:1 |
  | `.list.codex .lname-text` ("Adversarial Review", "Adversarial Test") | 15px / 600 | `#b4862a` on `#fbf8f1` | **3.10:1** | 4.5:1 |
  | `.list .lkind .cdx` ("phase: adversarial-review") | 9.5px / 400 | `#b4862a` on `#fbf8f1` | **3.10:1** | 4.5:1 |
  | `.chip.waiting` ("waiting", Review card) | 10px / 400 | `#b07215` on `#f6ecd0` | **3.39:1** | 4.5:1 |
  | `.card .state-callout.waiting` (the "Waiting on ..." sentence) | 12px / 400 | `#b07215` on `#f6ecd0` | **3.39:1** | 4.5:1 |

  None qualify as large text (all < 18.66px; none bold at >= 24px), so all need 4.5:1. Both
  offenders trace to two tokens in `ui/styles.css`: `--brass: #b4862a` (L22) and
  `--warn: #b07215` (L30), used as *text* colours on `--paper: #fbf8f1` / `--warn-soft: #f6ecd0`.
  The affected copy is not decorative — it is the wait reason, the goal-mode flag and the
  adversarial column identity.
- **fix:** Darken the two text tokens (the border/accent uses can stay). `#8a6410` measures
  **4.56:1** on `--warn-soft` and **5.06:1** on `--paper` — the shallowest value clearing 4.5:1
  on both; `#7d5a0e` (5.34:1 / 5.93:1) gives margin. Introduce `--brass-ink` / `--warn-ink` for
  the text usages (`.chip.goal`, `.chip.waiting`, `.list.codex .lname-text`, `.list .lkind .cdx`,
  `.state-callout.waiting`) and keep `--brass` for the left-edge accent.

### uxqa-4 — [major] Mobile body text and every text input are under 16px (iOS zooms on focus)
- **section:** Responsive & mobile usability
- **screenshot:** `screenshots/mobile-new-card-form.png`, `screenshots/mobile-board.png`
- **what + where:** At 390x844: `body` font-size is **14px**, the card title renders at **13px**
  and the meta chips at **10px** — all below the 16px mobile floor. Worse, every control in the
  New-card sheet is **13.5px**: `#nc-title` (text input), `#nc-desc` (textarea), `#nc-project`
  and `#nc-kind` (selects). Safari on iOS auto-zooms the page whenever a focused input's
  font-size is < 16px, so tapping the title field kicks the whole board out of its layout — on
  the surface that is explicitly meant to be iPhone-usable.
- **fix:** At the mobile breakpoint set `body { font-size: 16px; }` and force
  `input, select, textarea { font-size: 16px; }` (the single most important line — it is what
  suppresses the iOS zoom); raise `.card .ct .title` to >= 16px and the chips to >= 12px.

### uxqa-5 — [major] Empty lists render a bare lowercase "empty" over a 1000px blank column
- **section:** Error & empty states
- **screenshot:** `screenshots/desktop-empty-lists.png`
- **what + where:** The Adversarial Review and Adversarial Test columns hold no cards. Each
  renders a single muted lowercase word — **"empty"** (`div.lempty`, `ui/main.tsx:1496`) — at the
  top of an otherwise blank ~1000px-tall column. No heading, no explanation of what belongs
  there, no next step. This is precisely the "bare no-data" pattern the checklist flags, and it
  is the worst place for it: these are pipeline stages, so a new user cannot tell whether the
  column is broken, unreachable, or simply idle.
- **fix:** Replace `<div className="lempty">empty</div>` with a small empty-state block: a
  heading ("No cards"), one sentence naming how cards arrive ("Cards land here from Review when
  the fresh-context pass approves"), and — for the manual lists only — an inline "New card" CTA.
  The list's `phase` / `validNext` metadata is already in scope to generate that sentence.

### uxqa-6 — [major] Validation error is banner-only, 335px away from the field it is about
- **section:** Error & empty states
- **screenshot:** `screenshots/desktop-new-card-validation-error.png`
- **what + where:** In the New-card sheet, press "Create card" with Title and Description both
  empty. The message that appears is *good* prose — "Add a title or a description — the title is
  inferred from the description when left blank." — visible, plain language, names the fix, and
  it passes contrast (6.04:1). But it renders **only** as a generic `.banner` at the **bottom of
  the sheet** (y=629), **335px below the Title field** (y=253) it refers to. Neither `#nc-title`
  nor `#nc-desc` gets `aria-invalid`, and the banner carries no `role="alert"` / `aria-live`, so
  a screen-reader user is told nothing at all. On the 390px viewport the banner sits below the
  fold — you press Create, nothing appears to happen, and the reason is off-screen.
- **fix:** Render the message inline directly under the Title/Description fields (the two it is
  about), set `aria-invalid="true"` + `aria-describedby` on them, and add `role="alert"` to the
  banner so it is announced. Keep the wording — it is already right.

### uxqa-7 — [minor] "Advance" and "Move" sit side by side and do the same thing; neither names its destination
- **section:** Navigation clarity
- **screenshot:** `screenshots/desktop-board.png`
- **what + where:** On a manual list with exactly one valid next list — Backlog, whose `validNext`
  is `["todo"]` — the card front shows **both** "Advance" (primary) and "Move" (secondary).
  Clicking either sends the card to To Do: Advance calls `api.start()`, and Move short-circuits
  (`ui/main.tsx:1508-1516`: "One valid next list -> just move") and PATCHes the card to the same
  list. Verified live: clicking Move took Backlog 1 -> 0 and To Do 1 -> 2 with no picker. Two
  adjacent controls, one outcome — and neither label says where the card is going; you have to
  click to find out. (Where a real choice exists the picker is good: from needs-attention, Move
  correctly opens a sheet offering "To Do / Plan / Implement".)
- **fix:** Name the destination on the single-target path — "Advance -> To Do" — and hide Move
  when `validNext.length === 1` (it is then a duplicate of Advance). Keep Move, labelled
  "Move...", only where a choice actually exists.

### uxqa-8 — [minor] The post-Advance notice leaks the internal list id ("Moved to todo")
- **section:** Consistency
- **screenshot:** `screenshots/desktop-advance-notice.png`
- **what + where:** Advancing the Backlog card shows the banner **"Moved to todo"** — the raw
  list **id**. Every other surface names the same list by its **title**, "To Do": the column
  header, the Move picker, the card's own activity log. One object, two names, one of them an
  internal identifier.
- **fix:** In the notice (`onStart`, `ui/main.tsx:1381`) resolve the id through
  `board.lists.find(l => l.id === res.advanced)?.title` before rendering — "Moved to To Do".

### uxqa-9 — [minor] The mobile topbar wraps its primary CTA and card-count chip onto two lines
- **section:** Consistency
- **screenshot:** `screenshots/mobile-board.png`
- **what + where:** At 390px the header cannot fit its contents: the brand wraps to "Kanban /
  Loop", the count chip to "11 / CARDS", and — worst — the **primary CTA wraps to "New / card"**
  inside its own button. A two-line primary button is the most prominent control on the phone
  surface and it reads as broken layout rather than deliberate design.
- **fix:** `white-space: nowrap` on `.topbar .btn.primary` and the count chip; at the mobile
  breakpoint drop the "WORKFLOW BOARD" eyebrow and tighten the topbar padding to buy the room
  (or shorten the CTA to "New" with the "+" glyph on mobile).

### uxqa-10 — [minor] Card detail shows seven bare "—" rows with no explanation of what fills them
- **section:** Error & empty states
- **screenshot:** `screenshots/desktop-card-detail.png`
- **what + where:** Open a card that has not run yet (any Backlog card). The artifact table lists
  **PLAN, BRIEF, SESSIONS, GATE MARKERS, EVIDENCE INDEX, VIDEO, LOGS** and renders a bare em dash
  against every one. The row labels are there, but nothing says *why* they are empty or *when*
  they fill. The section immediately below gets this right — DECISION LOG says "No runs recorded
  yet." — so the same screen is inconsistent with itself.
- **fix:** Mirror the DECISION LOG treatment: replace the dashes with one line of context for the
  group ("No artifacts yet — these fill in as the card moves through Plan, Implement and
  Walkthrough."), keeping the dash only for individually-absent rows once a run exists.

### uxqa-11 — [note] Thirteen lists in a horizontal scroller at 390px, with no position indicator
- **section:** Navigation clarity
- **screenshot:** `screenshots/mobile-board.png`
- **what + where:** On mobile the board is a horizontal scroller showing roughly one column at a
  time; reaching the last list (Needs attention) from Backlog takes ~12 swipes, with no
  pagination dots, no list switcher and no indication of how many columns lie ahead. This is the
  conventional mobile-kanban pattern (Trello behaves the same way), which is why it is recorded
  as a note rather than a finding — but Trello pairs it with a jump affordance and this does not.
- **fix (optional):** Add a compact list switcher to the mobile topbar (a `<select>` of the 13
  lists that scrolls the chosen column into view), or pagination dots under the topbar.

---

## Checked and passing (not findings)

Recorded so the walk is auditable — these were measured or exercised and are fine:

- **No horizontal page scroll** at 375px, 768px or 1024px (`scrollWidth === clientWidth` at all
  three; the board's own left/right scroller is an internal container — the standard kanban
  pattern — not a page overflow). The [blocker] responsive item passes.
- **Viewport meta** is correct: `width=device-width, initial-scale=1.0, viewport-fit=cover`.
- **Tap-target floor**: zero interactive elements below 24x24 CSS px anywhere (the WCAG 2.2 AA
  floor is met; uxqa-1 is about the 44px comfort target, not the floor).
- **Destructive actions are gated.** "Delete card" opens an inline confirm spelling out the blast
  radius ("Delete this card, its logs, its run directory, and its brief? This can't be undone.")
  with a Cancel; "Abandon & prepare revert" double-gates through `window.confirm` and never
  auto-applies the revert. (`screenshots/desktop-delete-confirm.png`)
- **The dispatch error state is excellent.** With no gateway reachable, Run surfaces "gateway not
  reachable — start an operative (composition up) before dispatching an agent list" — plain
  language, names the cause *and* the fix, and persists on the card.
  (`screenshots/desktop-run-dispatch-error.png`)
- **Long-running feedback**: a running card shows a `RUNNING ON IMPLEMENT` callout, a live elapsed
  timer, and "waiting for the operative's first output..." — no silent wait.
- **Every form control has a visible, associated label** (all five in the New-card sheet: Title,
  Project, Description, goalMode, Work kind) — no placeholder-only fields.
- **Focus ring is visible** (1px solid `#101010`, far above the 3:1 minimum) and the tab order *on
  the board* is logical: topbar, then list by list, card by card. (The modal is the exception —
  uxqa-2.)
- **Escape closes** the sheets.
- **Current location is indicated** — each column is titled and the card front names its list.
- **No console errors** during the walk.
- **Waiting copy is truthful**: "Waiting on Fence trailer on every phase commit (ETXYAR): medium
  overlap, until stability" — grade-aware and specific.
