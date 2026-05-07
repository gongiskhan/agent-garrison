---
name: Projects Index
description: List, describe, and read files from local projects under ~/Projects/.
---

# Projects Index

Find and read projects on disk without pasting paths.

## When to use

Whenever the principal mentions a project by name, asks "what
are you working on", or starts a discussion that references a
codebase. Start with `list` to find the match, then `describe`
only if you need shape/structure, then `read` only for specific
files. **Do not pull entire codebases into context.** Quote
sparingly; summarize project shape in your own words rather than
pasting README excerpts back.

## Setup

Resolved by the runner from Fitting config:

```
PROJECTS_INDEX_ROOT=...   # defaults to ~/Projects
```

## CLI

The `projects.py` CLI runs from the Fitting's installed
directory (`apm_modules/_local/projects-index/`).

```bash
python scripts/projects.py list                  # projects with one-line descriptions
python scripts/projects.py describe <name>       # README + dir listing + CLAUDE.md hints
python scripts/projects.py read <name> <rel>     # one file, capped at 200KB
python scripts/projects.py --probe               # health check, prints "ok"
```

## Behavior

- **`list`** scans `projects_root` one level deep. Each immediate
  subdirectory is a project. Description is the first paragraph
  of `README.md` (or absent if no README). Output is alphabetical.
- **`describe`** of a known project returns:
  - top-level directory listing (depth 1, with default ignores),
  - the first ~30 lines of `README.md`,
  - the first ~50 lines of `CLAUDE.md` if present,
  - presence flags for common config files (`package.json`,
    `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`,
    `requirements.txt`, `.git/`).
- **`read`** returns up to 200KB of the requested file relative
  to the project root. Larger files are truncated with a marker.
  Requests escaping the project root (`..`) are rejected.

## Defaults

- `projects_root`: `~/Projects` (override via Fitting config or
  `PROJECTS_INDEX_ROOT` env var).
- Ignore list (always applied to listings): `.git`, `node_modules`,
  `.next`, `dist`, `build`, `__pycache__`, `.venv`, `venv`,
  `target`, `.cache`, `.turbo`.

## Operating principles

- One call at a time. Don't pre-fetch everything you might need.
- Ambiguous name → use `list` to disambiguate, then ask the
  principal which project they meant.
- Respect the file-size cap; if a file is too big, ask before
  attempting to read it in chunks.
