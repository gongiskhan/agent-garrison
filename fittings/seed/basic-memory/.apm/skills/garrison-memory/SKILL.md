---
name: Garrison Memory
description: Operative memory backed by Basic Memory — a plain-markdown Obsidian vault indexed into a queryable knowledge graph, shared across Claude, Codex, and Gemini.
---

# Garrison Memory

Operative memory is a single Obsidian vault indexed by **Basic Memory**
(basicmachines-co). The vault is plain markdown; Basic Memory builds a
local SQLite knowledge graph (notes, observations, relations) and exposes
write/search/read tools over MCP. The same MCP server is registered with
Claude Code, Codex, and Gemini, so all three agents read and write the
same memory. Zero lock-in: drop Basic Memory and a clean vault remains;
the index rebuilds from the files.

## How it works

The Basic Memory Fitting:

- Installs `basic-memory` and registers the vault as project `main`
  (`~/ObsidianVault` by default — it must live outside macOS
  TCC-protected folders so headless tools can reach it).
- Registers the `basic-memory mcp` server with Claude Code (and Codex +
  Gemini) so memory tools are available in-session.
- Wires a lightweight **SessionEnd / PreCompact capture hook** that writes
  a secret-redacted session checkpoint into the vault's `Memory/` folder.
  No LLM runs — it is just metadata plus a short transcript tail. Basic
  Memory's watcher indexes it on the next sync.

A separate launchd agent (`com.ggomes.obsidian-vault-sync`) commits and
pushes the vault on an interval, so memory written by any agent — even
when no editor is open — syncs across machines via git.

## Using memory (MCP tools)

Prefer the Basic Memory MCP tools over reading raw files:

- `search_notes` / `search` — full-text + semantic search across the
  whole vault. Use this first to recall.
- `read_note` — read one note by title or permalink.
- `build_context` — pull the context around a topic (note + its relations)
  to continue a line of work.
- `recent_activity` — what changed recently across the knowledge base.
- `write_note` — persist a durable memory as a markdown note.

CLI equivalents exist for non-MCP contexts:
`basic-memory tool search-notes "<query>"`, `... read-note <permalink>`,
`... write-note --title "<t>" --folder <dir>` (content via stdin).

## Writing durable memories

When you persist a memory, write a real note, not a log line:

```markdown
---
title: <Note Title>
type: note
tags: [<project>, <topic>]
---
# <Note Title>
<1–3 sentence core idea>
## Observations
- [decision] <durable decision> #governance
- [gotcha] <non-obvious failure mode> #ops
## Relations
- relates_to [[<Other Note Title or permalink>]]
- part_of [[Projects/<Project>]]
```

- Observations use `- [category] text #tag` (categories: decision, gotcha,
  fact, method, preference, tip). Relations use `- relation_type [[Target]]`.
- Route notes by project: `Projects/<Project>/Memory/` for project memory,
  `Personal/` for personal/business memory, `Compiled/` for cross-cutting
  concepts/gotchas/procedures.

## Operating principles

- Recall before you ask: `search_notes` the vault first.
- Treat secrets as non-memory. The capture hook redacts `sk-*`, `ghp_*`,
  `xoxb-*`; you should too. The vault is for context, not credentials.
- Keep entries concise and source-attributed. Prefer one durable note per
  topic with relations over many fragments.
- Don't quote the whole corpus back to the principal — search for the
  specific note, then answer from it.
