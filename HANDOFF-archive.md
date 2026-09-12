# Archive

- Open `/archive`; board, cards, notes, search, Inbox, import, Trash and Jobs
  are under `/archive/*`. API: `/api/archive/*`; core: `packages/archive/`.
- The active Basic Memory selection supplies `vault_dir` (project `main`).
  Yours is `Archive/`; every other visible vault folder is Garrison's area.
- Derived local data: `$GARRISON_HOME/archive/` (index, jobs, ingestion ledger,
  thumbnails, legacy redirects). Deleting it rebuilds from files; it is not synced.
- Schema-4 `global_config.archive`: `extract_target: cc-sonnet`,
  `max_file_mb: 25`, `pdf_max_pages: 30`, `author: Gonçalo`.
- Agents read Yours only when asked and never write there. Claude Code and
  Agent SDK enforce the Basic Memory ownership hook; Codex/Gemini use the rule.
  Automatic capture, mirrors, startup and improvement inputs exclude Archive.

## Imported

Existing Trello credentials on dev-madrid were verified and sealed through the
secret authority; no new key/token was necessary. The ten-minute preview window
received no selection, so the brief's largest-board default was used:
**Baby D & Fraldinhas**, without archived cards or a prefix.

- 10 lists, 2,985 cards, 38 downloaded attachments; no links, oversize or skips.
- 38 sidecars processed successfully; zero failed.
- Recovery tag: `archive/pre-import-Z1vIK3SI-2026-09-11T22-14-22-959Z-bbd63d`.
- Import and ingestion were pushed by vault-git-sync; the ingestion receipt was
  `2026-09-11T22:56:15Z`. Final sync `2026-09-12T00:34:46Z` matched local/remote
  vault commit `6a44efcbf1ddf53dbeee6e078c7f45283b1c8d62`.
- Re-running skips existing cards by `source: trello:<id>`.

To reverse an import-only commit, use `git -C <vault> revert <commit>` and let
vault-git-sync distribute the corrective commit. Here sync commits also contain
other changes: restore the tagged Archive state in a temporary recovery branch,
retain subsequent edits, commit only the intended correction, then cherry-pick
that corrective commit onto the current vault branch. Never reset shared history.
The retired Documents store had zero artifacts; existing artifacts on other
nodes migrate to `Projects/Garrison/Documents` with redirects and originals kept.

## Evidence

- [Decision and final verification](docs/decisions/2026-09-11-archive.md).
- [Fixture evidence and reproduction](evidence/archive/README.md).
- [Narrated phone walkthrough](.walkthrough/runs/agent-garrison/archive/2026-09-12/phone/final.mp4),
  63.2 seconds, seven narration beats. All images and documents are synthetic.

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
The independent Two Homes activation remains unfinished; automatic deployments
stay paused. Madrid is deployed and healthy; all 35 peer-work paths are restored.
Acceptance tested committed main with that unfinished work preserved separately.
Archive does not activate that migration or resume its rollout.
