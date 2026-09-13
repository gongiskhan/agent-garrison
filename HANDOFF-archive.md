# Archive

- Open `/archive`; folders, documents, notes, search, bookmarks, import, Trash and Jobs
  are under `/archive/*`. API: `/api/archive/*`; core: `packages/archive/`.
- The active Basic Memory selection supplies `vault_dir` (project `main`).
  One library combines all folders; existing paths and ownership stay intact.
- Derived local data: `$GARRISON_HOME/archive/` (index, jobs, ingestion ledger,
  thumbnails, legacy redirects). Deleting it rebuilds from files; it is not synced.
- Schema-4 `global_config.archive`: `extract_target: cc-sonnet`,
  `max_file_mb: 25`, `pdf_max_pages: 30`, `author: Gonçalo`.
- Agents read personal documents only when asked and never write there. Claude Code and
  Agent SDK enforce the Basic Memory ownership hook; Codex/Gemini use the rule.
  Automatic capture, mirrors, startup and improvement inputs exclude Archive.

## Imported

Existing Trello credentials on dev-madrid are sealed through the secret authority.
On 12 September the owner corrected the selection to **GERAL**, without archived
cards or a prefix. The earlier timeout-default board is no longer active.

- GERAL: 25 lists, 496 cards, 323 downloaded attachments, 9 links (including
  two oversized attachments); no skipped cards.
- The wrong board's ten lists / 2,985 cards are recoverable in Trash. All current
  files were preserved, and zero old-board source IDs remain active.
- Correction recovery tag: `archive/pre-correction-GERAL-2026-09-12T07-21-45-211Z`.
- GERAL import tag: `archive/pre-import-vl1Z8KFH-2026-09-12T07-22-40-440Z-80ff54`.
- The extraction queue has drained; three files failed, two because Madrid lacks
  HEIC conversion. Jobs shows the remaining details and unsupported types.
  Import and cleanup sync receipts are recorded in the decision.
- Follow-up cleanup removed eight task lists / 175 cards to Trash: 321 active
  cards remain. Tag: `archive/pre-task-cleanup-2026-09-12T08-31-41-063Z`.
- Re-imports keep trashed imported cards/lists removed until restored.
- Inbox is retired; upload files directly into a document.

To reverse an import-only commit, use `git -C <vault> revert <commit>` and let
vault-git-sync distribute the corrective commit. Here sync commits also contain
other changes: restore the tagged Archive state in a temporary recovery branch,
retain subsequent edits, commit only the intended correction, then cherry-pick
that corrective commit onto the current vault branch. Never reset shared history.
Retired Documents artifacts migrate to `Projects/Garrison/Documents` with originals kept.

## Evidence

- [Decision and final verification](docs/decisions/2026-09-11-archive.md).
- [Fixture evidence and reproduction](evidence/archive/README.md).
- [Narrated phone walkthrough](.walkthrough/runs/agent-garrison/archive/2026-09-13/unified-library/phone/final.mp4),
  62.6 seconds, seven narration beats. All images and documents are synthetic.

The earlier staging error in `954e3a0d` was corrected by `f948abb4`; do not
deploy that intermediate commit. The decision document preserves the history.

One library has folder lists, stars, bookmarks, safe-area attachment dialogs and
`garrison_archive_search` / `garrison_archive_read` in working assistant sessions.
The real assistant test retrieves a sensitive synthetic company certificate,
returns only its requested number with a clickable citation and leaves the vault
unchanged. Release `8a06644c` is live on Madrid, Pro, Mini and Air (40/40 checks).

## Needs the physical phone

Camera upload inside the iOS webview (`capture="environment"`), pinch zoom, and
HEIC from an actual iPhone photo. These cannot be accepted through emulation.

## Node binaries

- Madrid: missing `heif-convert`; `sudo apt-get install libheif-examples`.
- Mini and Air: missing Poppler/Pandoc; `brew install poppler pandoc`.
- Pro: required PDF, DOCX, thumbnail and HEIC tools are present.
- CSG has no Basic Memory; if stationed later, install tools with
  `sudo apt-get install poppler-utils pandoc imagemagick libheif-examples`.
- XLSX, PPTX, audio and video extraction remain unsupported. Thumbnails fall
  back to the original image when no converter exists.

## Later

None from the scoped review. All five crucial findings were fixed and tested.
Automatic deployments remain paused for the independent CSG rollout gate.
Full normal sync passes on all four; D63 records preserved derived-file recovery.
Bookmarks live in `Archive/_bookmarks.md`; stars remain document frontmatter.
External editor renames may leave a missing bookmark; remove it and save the new path.
