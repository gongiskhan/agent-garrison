# Codex memory workflow

This is the selective Claude-to-Codex continuity setup for Garrison. It keeps
the useful project knowledge and the authoritative Obsidian/Basic Memory vault,
without importing the Claude hook stack or Auto-thing machinery that had made
Garrison sessions slow.

## Source precedence

Use sources in this order:

1. Current user request and repository instructions.
2. The live checkout and runtime on `dev-madrid`.
3. The Mac editing checkout and its current working tree.
4. Current, named Basic Memory topic notes in project `main`.
5. Claude project memory and historical sessions as evidence only.
6. Archived checkouts and stale vault clones for archaeology only.

`AGENTS.md`, `CLAUDE.md`, and the implementation outrank memory. Also check
`PRD.md`, `PLANING.md`, and `TASKS.md` whenever they exist. Memory can lag code;
verify operational claims against the VM.

## Authoritative memory service

The authoritative vault and Basic Memory service remain on `dev-madrid`:

| item | authoritative location |
|---|---|
| Obsidian vault | `/home/ggomes/ObsidianVault` |
| Basic Memory project | `main` |
| Basic Memory executable | `/home/ggomes/.local/bin/basic-memory` |
| Claude Garrison memory source | `/home/ggomes/.claude/projects/-home-ggomes-dev-garrison/memory` |
| generated Obsidian mirror | `Projects/Garrison/Memory/Claude Native` |
| mirror program | `/home/ggomes/.claude/tools/claude-memory-to-obsidian.py` |
| scheduled vault Git sync | `/home/ggomes/.claude/tools/obsidian-vault-sync.sh` |
| sync schedule | user systemd `garrison-obsidian-vault-sync.timer` (every 5 minutes) |

Mac Codex connects to that service over the existing `dev-madrid` SSH alias.
The user-level Codex MCP entry runs:

```text
/usr/bin/ssh -T -o BatchMode=yes -o ConnectTimeout=5 \
  dev-madrid /home/ggomes/.local/bin/basic-memory mcp
```

It is deliberately not marked required: editing can continue during a brief VM
outage, while failed automatic checkpoints remain queued locally.

The old Mac vault clone was far behind the VM and contained hundreds of local
changes, so none of it was merged into the authority. It is preserved at
`/Users/ggomes/Archived ObsidianVault before Dev Madrid sync 2026-08-03`.
`/Users/ggomes/ObsidianVault` is now a clean clone of the pushed Dev Madrid
vault for Obsidian on the Mac. Dev Madrid remains authoritative, and Codex reads
and writes its Basic Memory project directly rather than relying on clone lag.

Claude's native Garrison project memory is also retained. Every top-level
Markdown note in the source directory is mirrored, by filename, into the
generated `Claude Native` folder before each scheduled vault Git sync. This
includes `MEMORY.md` and all notes linked from it. The mirror is atomic,
single-instance, update-only, and credential-redacting. It never scans sibling
projects, sessions, prompts, settings, hooks, or skills; it never deletes a
destination note when Claude removes or renames the source. A hidden manifest
records source, rendered, and current destination hashes, redaction counts, and
preserved orphans. Updates are keyed to the Claude source hash so Basic Memory
can normalize frontmatter without the mirror rewriting every note on each run;
the existing destination is still credential-scanned every time.
Edit Claude-native notes at their source; the Obsidian copies are generated.

The previous isolated checkout is archived at
`/home/ggomes/dev/Archived Garrison Codex`. It has no unique commits relative
to current `main`; its one safety stash remains in place for archaeology. Do
not use it as a development checkout or add a compatibility symlink at its old
path.

## What Codex loads and captures

Codex native memory generation and use are enabled in the user config. Native
memory is generated state; it does not replace checked-in rules or maintained
Basic Memory notes.

The same privacy-safe user hook is installed on both development hosts and is
scoped by resolved working directory:

| Codex host | hook program | active repository root | Basic Memory transport |
|---|---|---|---|
| Mac | `/Users/ggomes/.codex/garrison-memory-hook.py` | `/Users/ggomes/dev/garrison` | SSH to `dev-madrid` |
| `dev-madrid` | `/home/ggomes/.codex/garrison-memory-hook.py` | `/home/ggomes/dev/garrison` | direct local CLI |

Each copy is silent outside its listed Garrison root. The VM hook writes to the
same authoritative Basic Memory project directly; it does not SSH back into
itself. This keeps continuity intact if Codex CLI is used on the VM for an
exceptional diagnosis, while the normal workflow remains Mac editing with VM
execution.

- `SessionStart` injects a short cached `Codex Startup Brief` and refreshes the
  cache asynchronously from Basic Memory.
- `PreCompact` and `SessionEnd` atomically update one structural checkpoint per
  Codex session.
- Checkpoints contain only a session hash, event, time, model, branch, commit,
  and tracked changed paths. They never read prompts, transcripts, command
  history, environment variables, diffs, or file contents.
- A detached worker writes checkpoints to Basic Memory. Failed writes remain in
  `~/.codex/garrison-memory-spool` and retry at the next lifecycle event.
- The foreground `SessionEnd` path stays below the three-second Codex limit.

This automatic capture is only a safety net. At a meaningful milestone,
explicitly update a stable topic note with:

- the decision and why it was made;
- evidence and verification performed;
- current operational status;
- remaining risks and exact next steps.

Never store API keys, bearer tokens, JWTs, private keys, full configuration
files, or raw transcripts. The native-memory mirror strips known credential
forms and high-entropy secrets before writing. Raw Claude/Omi session files
remain outside Obsidian and must not be copied wholesale.

Before this migration, a global Claude `PreCompact`/`SessionEnd` hook wrote
bounded transcript-tail excerpts into timestamped `Memory/session-…` notes.
All 3,295 existing notes are preserved, but that capture path was retired on
2026-08-03. Its replacement is Garrison-working-directory scoped,
transcript-blind, and structural only: it stores a hashed session key and safe
lifecycle metadata with mode `0600`, never prompt/response text or the raw
session id. An outside-Garrison lifecycle event writes nothing. Codex does not
install or call this Claude hook; its own structural checkpoint is the separate
mechanism described above.

The Mac Claude lifecycle entries use the same scoped structural writer with a
`Claude` source label and send through the authoritative Basic Memory service;
they no longer write transcript tails into the Mac vault clone. A stray
`skill-improver` tail created by the retired Mac command during migration was
quarantined in the archived pre-sync vault and was never pushed into the
authoritative vault.

The curated continuity notes created during migration are:

- `Projects/Garrison/Memory/Codex Startup Brief`
- `Projects/Garrison/Memory/Codex Development Workflow`
- `Projects/Garrison/Memory/GLM 5.2 Continuation`
- `Projects/Garrison/Memory/Omi and Personal Assistant Continuation`

Those concise notes are the maintained entry points. The complete historical
Claude-native notes remain available below
`Projects/Garrison/Memory/Claude Native/MEMORY` for detailed archaeology and
Basic Memory search.

## Recovered Claude history

The relevant historical Claude sessions were mapped without copying their raw
transcripts. Their private session identifiers remain in the authoritative
vault rather than in public Git history. The current state and remaining work
from those sessions are captured in the named topic notes and in
`docs/REMOTE_MAC_WORKFLOW.md`. The separately authored Claude project-memory
notes are mirrored into Obsidian as described above. Raw JSONL files stay on the
VM and are not part of the Codex workflow.

## Deliberate exclusions

Do not import or re-create:

- Claude user/project settings wholesale;
- Auto-thing, phase, or goal-loop skills;
- Improver probe or stop-continuation behavior;
- Claude's per-tool capture or timestamped transcript-tail hook in Codex;
- the old `run-garrison` launch skill;
- the archived checkout's projected `AGENTS.md`, `.codex/skills`, vault, or
  runtime home;
- a blanket “all multi fittings are defaults” interpretation of `default_fit`.

The remote Claude settings had accumulated 491 hook groups, primarily repeated
Garrison dev-environment relays and Improver probes. The migration reduced
those repeated Garrison registrations to one current owner-scoped set while
preserving Basic Memory and unrelated Claude hooks. None of that Claude hook
machinery is loaded by Codex.

## Validation and trust

After changing the user-level hooks, fully exit and relaunch the Codex CLI on
the host being used, then review and trust the exact three Garrison definitions
when the startup prompt appears. `/new` does not reload hook files. Until the
definitions are reviewed, Codex skips these non-managed hooks by design.

Both hosts use `~/.codex/hooks.json`, but they are separate files. The compact
Codex banner shortens both repository paths to `~/dev/garrison`, so use `pwd`
or `hostname` when the host is ambiguous: `/home/ggomes/dev/garrison` is the VM
and `/Users/ggomes/dev/garrison` is the Mac. Running `/hooks` in one does not
inspect the other host's file.

Useful checks from the Mac are:

```bash
codex mcp get basic-memory
cd /Users/ggomes/dev/garrison
make remote-doctor
```

The Basic Memory transport should show `/usr/bin/ssh` and `dev-madrid`. The
remote doctor must pass without exposing secrets or changing either checkout.
If automatic capture cannot reach the VM, leave queued spool files in place;
the next Garrison lifecycle event retries them.

On the VM, the mirror itself can be checked safely and idempotently with:

```bash
/home/ggomes/.claude/tools/claude-memory-to-obsidian.py
```

Check the automatic owner and its next run with:

```bash
systemctl --user status garrison-obsidian-vault-sync.timer
systemctl --user list-timers garrison-obsidian-vault-sync.timer
```

The summary should report the same source-note count as the source directory;
the 2026-08-03 migration baseline is 44 Markdown notes in each location. A
second unchanged run should report zero updated notes. The enabled user timer
invokes the normal vault sync every five minutes; that script runs the mirror
before committing and pushing Obsidian changes. After a bulk import, run a
Basic Memory incremental sync so the new notes are searchable immediately
rather than waiting for its watcher.

Basic Memory project `main` is the sole active/default project. The former
`codex` registration was removed without deleting its files; the archived vault
remains at `/home/ggomes/.garrison-codex/ObsidianVault` for archaeology.
