---
name: Garrison Memory
description: Operative memory backed by claude-memory-compiler — auto-captured sessions compile into a queryable knowledge base.
---

# Garrison Memory

Maintain operative memory with explicit user-visible persistence.

## How it works

The Memory Fitting wires three Claude Code hooks (SessionStart,
SessionEnd, PreCompact) into `~/.claude/settings.json`. Those hooks
run `claude-memory-compiler` from `~/.claude/memory-compiler`:

- **SessionStart** — injects the compiled-knowledge index into the
  next session's context as a map of what's known.
- **SessionEnd / PreCompact** — extracts decisions, lessons,
  patterns, and gotchas from the conversation, appends to a daily
  log, and (after 6 PM local time, on the next session) compiles
  the day's logs into structured articles.

Output lives at `$COMPILER_OUTPUT_DIR` if set; else at the canonical
vault `~/Projects/ekus/obsidian-vault/Compiled`; else at the legacy
`~/.claude/memory-compiler/knowledge`.

## Operating principles

- Keep a recency window for current-session recall.
- Treat secrets as non-memory unless the user explicitly marks them
  safe to retain. Vault is for secrets; memory is for context.
- Prefer concise, source-attributed memory entries.

## Querying compiled memory

The injected index at session start is a **map**, not the corpus.
To fetch the body of a specific article, run:

```sh
uv run --directory ~/.claude/memory-compiler python scripts/query.py <slug-or-keyword>
```

Don't quote the index back to the principal. Don't pull the whole
corpus into context. Query for the specific article, then answer
from the result.

If `scripts/query.py` is missing on your install, list articles
directly from the output dir (e.g. `ls $COMPILER_OUTPUT_DIR/concepts/`)
and read individual files with the standard `Read` tool.

## When to compile manually

The compiler runs automatically once a day after 6 PM local time on
the next session flush. To force-compile now:

```sh
uv run --directory ~/.claude/memory-compiler python scripts/compile.py
```

A `--dry-run` flag is supported.
