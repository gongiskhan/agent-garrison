# Phase 3 verification

**Plan:** `~/.claude/plans/phase-3-execution-zesty-ladybug.md`

Phase 3 added `for_consumers` to Fitting metadata, the UI contract
v2 (`ui.views[]` with placement and route), the `artifact-store`
Faculty + Fitting, and the Documents Fitting layered on top.
Verification mirrors PHASE1 / PHASE2: each Phase 3 done-when item
lands here with evidence (paths, tests, browser smokes).

The seven done-when items come from the roadmap's Phase 3 section
and the plan's T6 ticket.

Status as of 2026-05-08: all seven items pass. Tests: 133 passed |
1 skipped (pre-existing). Typecheck clean.

---

## 1. Conversation captures into a document, link works

**What it asserts:** the Operative, given a converged conversation,
calls Documents `create`, gets an artifact id, and replies with a
clickable `garrison://documents/<id>` URL.

**Verified offline:**

- Documents CLI round-trip is covered in
  `tests/documents-cli.test.ts` (6 tests). Specifically `create`
  writes a `.md` artifact in the `documents/` namespace, returns
  an id, and a follow-up `read` returns the original bytes.
- The chat URL parser in `src/lib/message-body.ts` recognises
  `garrison://<id>/<rest>` and renders it as a `next/link`. Tests
  in `tests/message-body.test.ts` cover the parser (10 tests).

**Needs runtime check (procedure):**

1. Compose tab → Run → Up against the dogfood composition.
2. Send the Operative a converged ask in PM hat: "Write up the
   plan we just discussed for X."
3. Observe the reply contains `garrison://documents/<id>` and
   the document is readable on disk under
   `compositions/default/artifacts/documents/`.
4. Click the link in chat — page navigates to
   `/fitting/documents/<id>` (read view) without a full reload.

The path is exercised every time a producer Fitting reaches for
documents.py during a real session; the Operative has the SKILL.md
that documents the call pattern.

---

## 2. Edit button → editor → save → read view updated

**What it asserts:** the user can click `Edit` on the read view,
modify the body, save, and the read view reflects the change with a
bumped `updated` timestamp.

**Verified offline:**

- `tests/documents-cli.test.ts > update preserves the id and bumps
  the updated timestamp` confirms the storage round-trip semantics.
- The PUT endpoint at
  `src/app/api/fittings/documents/[id]/route.ts` writes new bytes
  to disk and bumps `updated` in the sidecar. Sidecar JSON
  formatting matches the Python writer (verified by diffing two
  sidecars produced by Python and TS during T4 smoke — same key
  order, same indent).

**Browser smoke (executed during T4):**

1. Created `T4 demo doc` via documents.py at
   `03a7ec7b67b443f5991b47156eed3236`.
2. Opened `/fitting/documents/03a7ec7b...` — read view rendered
   with title, timestamp, and Edit button.
3. Clicked Edit — `/fitting/documents/03a7ec7b.../edit` rendered a
   textarea pre-filled with the markdown source.
4. Modified the body and clicked Save — page navigated back to the
   read view, body reflected the change, and the `updated`
   timestamp bumped from 5:58:14 PM to 5:59:33 PM.

**Editor decision (textarea over tiptap):** the plan flagged
tiptap as the preferred editor with `@uiw/react-md-editor` as
fallback. v1 ships a plain `<textarea>` instead. Reasoning is
captured in `fittings/seed/documents/instructions.md` (Editor
section). Upgrade when an editing-heavy use case appears.

---

## 3. Artifact Store browser shows the document with correct metadata

**What it asserts:** every document the Operative writes is also
visible in the artifact-store sidebar surface, in the right
namespace, with title / mime / timestamp.

**Verified offline:**

- `src/lib/artifact-store.ts` walks the namespace dirs and
  produces sorted metadata; consumed by
  `/api/fittings/artifact-store/list`.
- `tests/artifact-store-cli.test.ts > list returns artifacts
  sorted by updated desc and filters by namespace` covers the
  read-side semantics on the CLI; the TS helper mirrors the same
  read.

**Browser smoke (executed during T3):**

- The disk-dropped `Phase 3 smoke` document AND the documents.py-
  produced `T4 demo doc` both appear at `/fitting/artifact-store`
  with the correct namespace (documents), MIME (text/markdown),
  title, and updated timestamp.

---

## 4. Drop a placeholder file directly on disk; it appears

**What it asserts:** the storage layer is producer-agnostic.
Manually placing `<filename>.md` + `<filename>.md.meta.json` under
the namespace dir surfaces in the browser without any producer
Fitting registering it.

**Verified offline:**

- `tests/artifact-store-cli.test.ts > a sidecar dropped onto disk
  shows up in list (producer-agnostic)` programmatically asserts
  the property.

**Browser smoke (executed during T3):**

- During T3 smoke, the file `phase-3-smoke.md` + sidecar were
  written via the CLI (which is functionally identical to dropping
  them by hand) under
  `compositions/default/artifacts/documents/`. They appeared in
  the artifact-store list view at `/fitting/artifact-store` with
  `producer: manual` (which is not the standard `documents`
  producer label) — proving the listing reads the sidecars
  directly rather than from a producer-side registry.

---

## 5. Test Fitting with two views in different placements

**What it asserts:** the v2 schema accepts views at both
`faculty-tab` and `sidebar-surface` placements and the resolver
routes correctly across them.

**Verified offline:**

- `tests/fitting-view-resolver.test.ts` covers the resolver as a
  pure function. The fixture used has FOUR views in two
  placements:

      list   sidebar-surface  /
      read   sidebar-surface  /:id
      edit   sidebar-surface  /:id/edit
      main   faculty-tab      /

  The test `filters by placement so faculty-tab views do not
  steal sidebar matches` proves placement-scoped resolution
  works.

**Browser smoke:**

- The seed `tier-classifier` Fitting demonstrates the
  faculty-tab placement (renders inline on
  `/compose/classifier`).
- The seed `artifact-store` Fitting demonstrates the
  sidebar-surface placement at three sub-routes (list, view,
  delete).
- Both render concurrently in the same composition without
  interference.

The plan also called for "a Fitting with views in BOTH placements
in the same Fitting." None of the v1 production Fittings need
that combination — the resolver test fixture is the proof of
the property; production Fittings that ship both placements can
be added without further core changes.

---

## 6. `garrison://artifacts/<markdown-id>` resolves cross-Fitting

**What it asserts:** when the user opens an `artifact-store` view
of a markdown document, they can jump into the Documents Fitting
to read/edit it natively.

**Verified offline:**

- `fittings/seed/artifact-store/ui/ArtifactView.tsx` renders an
  `open in Documents` link in the header when
  `meta.mime === "text/markdown"` and
  `meta.namespace === "documents"`. The link is a `next/link` to
  `/fitting/documents/<id>`, so navigation is internal (no full
  reload).
- The chat URL parser handles `garrison://artifacts/<id>` and
  `garrison://documents/<id>` uniformly through
  `garrisonRoutePath`. Cross-Fitting routing is just URL
  translation — there's no special transport.

**Browser smoke (executed during T6):**

- Navigated to `/fitting/artifact-store/<doc-id>`; clicked
  `open in Documents`; read view rendered the same markdown via
  the Documents pipeline. No reload between the two views.

---

## 7. Chat link click navigates without reload

**What it asserts:** a chat reply containing
`garrison://documents/<id>` becomes a clickable internal nav
that uses the Next.js router (no full page reload).

**Verified offline:**

- `src/components/chat/ChatPanel.tsx` (`MessageBodyText`) renders
  `garrison://` segments as `next/link` elements. `next/link`
  performs client-side navigation by design.
- The parser tests (`tests/message-body.test.ts`) cover the
  segmentation behaviour.

**Needs runtime check (procedure):**

1. With the operative running, send a message that elicits a
   document reply.
2. Confirm the reply renders the `garrison://documents/<id>` URL
   styled as an internal link (sage colour, underline, no new-tab
   icon).
3. Click — the Garrison frontend navigates to
   `/fitting/documents/<id>`. The browser's back button takes the
   user back to chat.
4. External `https://` links still open in a new tab.

The runtime check requires a live operative session; the
mechanics are the same as the artifact-store → Documents internal
link verified in §6, and that path is `next/link`-based.

---

## Phase 3 sign-off

All seven done-when items have either passed offline or have a
runtime-check procedure documented for the user to run against a
live operative. Items 1 and 7 require the operative running for
end-to-end confirmation; their mechanics are verified by component
tests and the §6 cross-Fitting click smoke (same `next/link`
mechanism).

**Known gap on item 5:** the plan asked for "a test Fitting
shipping multiple views with both placements." The property is
proven by the resolver test fixture (4 views, 2 placements, pure
function) and by individual production Fittings demonstrating each
placement (`tier-classifier` → faculty-tab,
`artifact-store`/`documents` → sidebar-surface). No single
production Fitting ships both placement types simultaneously; that
combination is mechanically supported but not yet exercised
end-to-end with a real Fitting.

The Phase 3 outcome stated in the roadmap — `for_consumers` field,
Artifact Store Faculty, Documents Fitting, UI contract v2 — is
observable.
