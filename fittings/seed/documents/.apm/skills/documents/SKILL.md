---
name: documents
description: Capture decisions, plans, and specs as markdown documents. Use this when a conversation has converged on something worth keeping, or when the user asks you to write something down.
---

# documents

Markdown documents workspace, layered on the Artifact Store. Each
document is an artifact in the `documents/` namespace; the artifact id
is the canonical reference and the URL `garrison://documents/<id>`
opens the user-facing read view in the sidebar.

## When to create a document

- In PM or Software Architect hat, when the discussion has converged
  on something worth keeping (a spec, a plan, a decision).
- When the user explicitly asks you to write something down.
- When your reply would be long, structured, and reusable beyond this
  turn.

Don't create documents for trivial single-turn answers, questions,
acknowledgements, or progress updates.

## When to update vs. create new

Prefer updating an existing document over creating a new one when the
content is about the same project / feature. Pattern:

```bash
python3 apm_modules/_local/documents/scripts/documents.py list
# scan the result for a relevant doc
python3 apm_modules/_local/documents/scripts/documents.py update <id> < /tmp/new-content.md
```

If no relevant document exists, create:

```bash
echo "## Feature X spec\n\n..." | \
  python3 apm_modules/_local/documents/scripts/documents.py create --title "Feature X spec"
```

`create` returns the artifact id on stdout. Capture it and reply with
`garrison://documents/<id>` so the user can click through.

## Reading

```bash
python3 apm_modules/_local/documents/scripts/documents.py read <id>
```

Pipes the markdown to stdout.

## What the user does

The user opens `garrison://documents/<id>` (the read view), or
`garrison://documents/<id>/edit` (the editor). The editor is the only
UI for mutating documents; if both you and the user are editing at the
same time, last write wins.

## Don't paste the document body in chat

Reply with the link, not the contents. The link is the artifact; chat
echoes are noise.
