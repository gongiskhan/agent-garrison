# Agent Garrison Fitting · Documents

Markdown documents workspace layered on the Artifact Store.

## What it does

- Operative writes documents via `scripts/documents.py create / update`.
- User reads at `/fitting/documents/<id>` and edits at
  `/fitting/documents/<id>/edit`.
- Documents live as `.md` artifacts in the artifact-store's `documents/`
  namespace. The Documents Fitting does not implement its own storage
  — it composes.

## Why a separate Fitting

The Operative needs a focused interface ("create a document about X")
that defaults producer, namespace, mime, and `.md` extension. Without
this Fitting the Operative would have to know the artifact-store CLI's
full surface and the conventions every time. Layered like this, the
artifact store stays generic and Documents stays small.

## Editor — textarea, not tiptap (v1 decision)

The Phase 3 plan flagged tiptap (with a markdown extension) as the
preferred editor and `@uiw/react-md-editor` as the fallback. v1 ships
a plain `<textarea>` instead. Reasoning:

- The Operative writes most documents; the user mostly reads, only
  occasionally edits. Editor sophistication is low-leverage.
- A textarea preserves markdown source 1:1 — no risk of a
  WYSIWYG conversion mangling `garrison://` links or code fences.
- The bundle stays small. tiptap pulls in ProseMirror; v1 doesn't
  need it.

Upgrade to tiptap when an editing-heavy use case shows up (likely
when Documents grows side-by-side preview).

## Out of scope (v1)

- RAG / search over documents.
- Per-project scoping (flat per composition).
- Multi-user / collaborative editing.
- Rich-media embedding (markdown text only).
- Document templates.
- Memory Fitting integration.

## Verify

`scripts/verify.sh` probes the artifact-store CLI through documents.py.
