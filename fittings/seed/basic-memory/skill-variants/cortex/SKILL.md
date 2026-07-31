---
name: Garrison Memory
description: Operative memory backed by a remote note vault reached through the `cortex` CLI — plain markdown notes addressed by permalink, searchable from every machine that holds a user-scoped key.
---
<!-- garrison-memory-backend: cortex -->
<!-- Installed by the basic-memory Fitting when `backend: cortex`. The default
     (local) variant is the fitting's own .apm/skills/garrison-memory/SKILL.md;
     setup.sh restores it when the backend flips back. Edit the SOURCE variant,
     never this installed copy. -->

# Garrison Memory

Operative memory is a **remote note vault** reached through the `cortex` command-line
client. The notes are plain markdown; the service indexes them and answers searches,
so memory written on one machine is readable from every other machine that holds a
key. A note's `permalink` (`folder/slug`, lowercase) is its identity: writing the same
permalink again OVERWRITES that note, it never duplicates — which is what makes every
write safe to retry. Zero lock-in: `cortex memory export` hands the whole vault back
as markdown.

## How it works

The Basic Memory Fitting, on this backend:

- Keeps the local Obsidian vault as the **capture substrate** (`~/ObsidianVault` by
  default) and keeps writing session checkpoints into its `Memory/` folder.
- Wires the same lightweight **SessionEnd / PreCompact capture hook**, which writes a
  secret-redacted session checkpoint. No LLM runs — it is metadata plus a short
  transcript tail.
- **Spools** each capture and drains it into the remote vault on a schedule
  (`cortex memory write --file <capture> --permalink <key> --json`). The permalink is
  the capture's idempotency key, so a retried drain overwrites instead of duplicating,
  and a capture that has not drained yet is still sitting in the spool.
- Does **not** register a local memory MCP server. There are no `search_notes` /
  `read_note` / `write_note` tools in this session; the CLI below is the whole ops
  surface.

Configuration is environment-only: `CORTEX_BASE_URL` (the deployment origin) and
`CORTEX_API_KEY` (a user-scoped key). There is no config file and no `--key` flag, so
the client cannot guess an origin or a credential and can never quietly talk to the
wrong deployment. If either is missing the CLI exits 2 and sends nothing. The key
belongs in the environment only — never echo it, never write it into a note, a log, or
a committed file.

Exit codes are worth knowing before you script anything: `0` the call succeeded, `1`
the service refused it or the request could not be made, `2` you got the invocation
wrong or an env var is missing (**nothing was sent**). `--json` prints exactly one JSON
document on stdout on success, and nothing on stdout on failure.

## Consolidation ("dream")

The **Improver** runs a nightly consolidation pass — the "dream" rule (mimics Claude
Code's `autoDreamEnabled`) — over the **local capture vault**, so the checkpoints piling
up there stay concise and true:

- **Deterministic housekeeping (auto):** archive `Memory/session-*.md` capture
  checkpoints older than `checkpoint_retention_days` (default 14) into
  `Memory/archive/`.
- **Consolidation proposals (review-queued):** one capped model pass proposes
  distilling durable notes from recent checkpoints, merging near-duplicates, resolving
  contradictions, and rewriting relative dates ("yesterday", "last week") to absolute
  ones. Proposals land in the Improver's review queue under rule `memory-dream` and
  apply only on approval.

That pass operates on the local vault, **not** on the remote one: nothing rewrites the
remote store behind your back. On the remote side the permalink does the de-duplication
— re-writing a permalink replaces the note. So write good checkpoints and durable notes,
and give a durable note a permalink you will write to again rather than a new one each
time.

## Using memory (the `cortex memory` CLI)

Reach memory through the CLI; do not read the vault's raw files to answer a question.

| upstream MCP tool | here |
|---|---|
| `search_notes` / `search` | `cortex memory search "<query>" --limit 5` |
| `read_note` | `cortex memory read <permalink>` |
| `write_note` | `cortex memory write --file <path>` / `--stdin`, with `--permalink` |
| `build_context` | **no equivalent** (see below) |
| `recent_activity` | **no equivalent** (see below) |

```bash
# recall first
cortex memory search "spool drain precedence" --limit 5
cortex memory read projects/garrison/spool-drain

# persist a durable memory
cortex memory write --file /tmp/note.md --permalink projects/garrison/spool-drain --json
printf '%s' "$note" | cortex memory write --stdin --permalink compiled/eviction-gotchas \
  --title "Eviction gotchas"

# browse and evacuate
cortex memory list --folder projects/garrison --limit 20
cortex memory export --out ~/vault.tar     # markdown only, no derived index
cortex memory delete projects/garrison/stale-note
```

`--title` is optional; it is derived from the body's first heading, else the file name,
else the last permalink segment. Give one when the note deserves a better title.

**Two upstream tools have no equivalent here, and there is no point pretending
otherwise:**

- **`build_context`** pulls a note *plus its relations* out of Basic Memory's local
  knowledge graph. The remote contract exposes notes, not the relation graph, and there
  is no contract operation for it today. The nearest honest substitute is manual: run
  `search`, `read` the top hits, and follow the `## Relations` links in the bodies by
  permalink. That is a worse tool doing a similar job — say so if you are asked whether
  you pulled a context graph, because you did not.
- **`recent_activity`** answers "what changed recently across the knowledge base". There
  is no contract operation for that either. `cortex memory list --folder <f>` prints
  each note's modified time within ONE folder, which is a listing you can eyeball, not
  an activity feed across the vault — do not present it as one.

If either gap starts costing real work, the fix is a new operation in the capability
contract (which every client then gets), never a private endpoint or a hand-rolled HTTP
call from this Fitting.

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
- relates_to [[<Other note's permalink>]]
- part_of [[projects/<project>]]
```

- Observations use `- [category] text #tag` (categories: decision, gotcha, fact, method,
  preference, tip). Relations use `- relation_type [[Target]]` — here they are prose the
  reader follows by permalink, not graph edges the service resolves, so **write the
  permalink, not a display title**, or the link is a dead end.
- Route notes by permalink folder: `projects/<project>/<slug>` for project memory,
  `personal/<slug>` for personal/business memory, `compiled/<slug>` for cross-cutting
  concepts, gotchas, and procedures. Lowercase, `/`-separated.

## Operating principles

- Recall before you ask: `cortex memory search` first.
- Treat secrets as non-memory. The capture hook redacts `sk-*`, `ghp_*`, `xoxb-*`; you
  should too. The vault is for context, not credentials — and this vault leaves the
  machine, so the rule is stricter here, not looser.
- Keep entries concise and source-attributed. Prefer one durable note per topic,
  re-written at a stable permalink, over a trail of near-duplicates.
- Don't quote the whole corpus back to the principal — search for the specific note,
  then answer from it.
- A write that exits non-zero did NOT land. Do not report a memory as saved on the
  strength of having run the command; check the exit code, and if the vault is
  unreachable say the memory was not persisted.
