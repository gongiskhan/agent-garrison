# Shared agent continuity

Claude Code, ChatGPT/Codex and Garrison sessions use the same repository
instructions and durable memory. This workflow replaces the August 2026
Garrison-only, remote-editing setup. Every enrolled machine is a full mesh node;
code travels through git on permanent node branches, and session artifacts stay
on their owner node.

## One instruction source

`AGENTS.md` is a relative symlink to `CLAUDE.md`. The canonical file retains the
rules that previously existed in both files, with common memory and concurrency
rules near the beginning. Edit `CLAUDE.md` to update both clients. Because the
full Garrison document exceeds Codex's default instruction budget, host setup
must set `project_doc_max_bytes = 65536` or greater in the active Codex config.
The core shared-memory rules are near the top even when a client truncates.

Other projects can opt into the same arrangement with the installer below. If
both files exist and differ, it preserves their complete texts in the canonical
file before creating the symlink, and creates private backups. Read the result
for conflicting project-specific instructions; mechanical preservation cannot
resolve differences in meaning. Existing noncanonical symlinks are refused.

Before meaningful work, check `PRD.md`, `PLANING.md`, and `TASKS.md` when present.
Garrison's current plan of record is `roadmap.json`; `docs/GARRISON_ROADMAP.md`
is history. Current user instructions, repository code and live node evidence
outrank older memory notes. Do not restore the retired remote snapshot workflow
from an August startup brief.

## Shared durable memory

All clients read and write Basic Memory project `main`, using the service on
`dev-madrid` for a common read/write view. On that host the command is
`/home/ggomes/.local/bin/basic-memory`; other nodes reach it through the existing
SSH alias. Each client must have its Basic Memory MCP configured to that same
service through the client's supported configuration command. The lifecycle
installer deliberately does not synthesize or replace MCP configuration.

The common namespace is `Projects/<project>/Memory`:

- `Agent Startup Brief` is the concise, maintained entry point for every client.
- Stable topic notes hold decisions, reasons, verification, current state and
  exact next steps. Search and read before editing; make scoped updates or
  dated corrections so another session's work survives.
- `Sessions/Agent Sessions <project-key> <node>` holds that node's bounded
  session roster, with source, status, last observation, branch and tracked
  paths. Every client can read every node's roster.
- `Sessions/Checkpoints/Agent Session <hash>` is the latest structural checkpoint
  for one session. It provides provenance, not a semantic account of the work.

Claude-native and Codex-native memories are local hot indexes. When an agent
records a new durable project fact there, it also writes the fact to the shared
topic. Semantic milestones require deliberate notes: a metadata hook cannot
infer why code changed or whether a test demonstrated the intended behavior.
The maintained shared brief replaces the old Codex-only brief in hook context.

`import-native` also preserves existing authored Claude project memories in
`Projects/<project>/Memory/Native/Claude/<node>`, keeping independent node sources
separate. It reads only top-level `.md` files in that explicit project's native
`memory` directory, at most 64 KiB each. It excludes symlinks, session/transcript
filenames and all sibling JSONL files, redacts credential patterns, hashes
successful source imports, and never deletes a shared copy when the source is
removed. Native-note export requires explicit authorization for the existing note
contents. Automatic import is off by default; only enable `native_import_enabled`
after that approval. When enabled, worker runs check for authored notes every
15 minutes with a bounded batch. Explicit import can process up to 100 changed
notes. A rejected export must not be retried through automatic hooks.
Source copies are evidence for targeted search, not additional instructions.

Existing Claude-native Garrison notes remain available through the generated
`Projects/Garrison/Memory/Claude Native` mirror. Keep generated copies read-only;
edit source notes or the curated shared topic. Historical notes and raw session
files are preserved. The installer retires known legacy transcript capture
hook entries; it does not migrate or delete their historical output. Vault Git
sync remains the mesh's existing memory transport and backup mechanism; this
bridge does not create another vault or a second sync daemon.

## Session awareness

`scripts/agent-continuity.py` is the same bridge for both clients. The foreground
hook only allowlists metadata, writes a private local record and starts a
detached worker. It does no Git work and waits on no remote service.

| Event | Observation |
| --- | --- |
| `SessionStart` | Ready, with shared startup context and peer observations |
| `UserPromptSubmit` | Active, with refreshed cached peer context |
| `PostToolUse` | Active heartbeat, throttled to at most one per minute |
| `PreCompact` | Active checkpoint |
| `Stop` | Idle after a turn; the session remains resumable |
| `SessionEnd` | Ended |

The worker collects branch, commit and tracked changed paths, publishes the
checkpoint and per-node roster to Basic Memory, and refreshes the shared brief
and peer rosters. No transcript path, prompt, response, tool input, tool output,
diff, untracked file content or environment value is inspected. A known Garrison
launch marker labels a session `Garrison/Claude` or `Garrison/Codex`; only the
presence of the marker is used. Session keys hash node, client, project and
session ID, so independent clients and nodes cannot overwrite each other.

Metadata, caches, queue and installation backups live at
`~/.local/state/garrison/agent-continuity`, with private files and directories.
Failed checkpoint and roster writes remain queued. Later lifecycle events or
an explicit `worker` invocation retry. Workers are serialized, and a successful
older write cannot remove a newer pending checkpoint. The old Codex bridge's
spool is left intact for historical recovery; it is not silently deleted.

A lifecycle observation is advisory. Ten minutes without a heartbeat means
**stale**, never automatically ended. Peer cache entries show their fetch time,
and every roster row has its observation time. A missing cache explicitly says
that peers have not been fetched. Verify current Garrison sessions on the owner
node before changing overlapping paths. Long-running sessions without tool
calls and clients whose hooks are not enabled may not have fresh observations.
Use Garrison's existing session controls to inspect or steer work; the memory
bridge does not duplicate the live session controller.

## Install on each host

Run from that host's Garrison git checkout after its code has arrived through
git. The installer preserves unrelated hooks, settings and global instructions,
including Garrison's native shell-event and coordination hooks. It replaces
only its own hooks and the known old `garrison-memory-hook.py` /
`.claude/basic-memory/capture-session.py` entries. Every changed existing file
receives a private backup, and repeated installation is idempotent. Basic Memory
fitting setup and verification recognize the six shared hooks, preserve them
across APM/up reruns, and retire only the historical transcript-capture entries.
An incomplete shared bridge fails setup instead of restoring transcript capture.

For a Mac (substitute its permanent mesh name):

```bash
python3 scripts/install-agent-continuity.py \
  --node mac-pro \
  --project "Garrison=$HOME/dev/garrison" \
  --project-parent "$HOME/dev" \
  --peer-node dev-madrid --peer-node mac-pro \
  --peer-node mac-air --peer-node mac-mini \
  --ssh-host dev-madrid \
  --basic-memory /home/ggomes/.local/bin/basic-memory
```

On `dev-madrid`, use the same arguments with `--node dev-madrid` and omit
`--ssh-host`. The config defaults to
`~/.config/garrison/agent-continuity.json`. A different Basic Memory executable
can be supplied explicitly; its location is never guessed from the presence of
a similarly named local executable.

`--project-parent` enrolls Git projects only beneath the selected directory.
Explicit `--project NAME=/absolute/path` aliases win over discovery and are
needed when a project has different directory names across nodes. Use the same
name on every node. Register separate aliases for unrelated repositories with
the same basename. Unknown folders and missing/relative hook cwd values are
ignored. Project checkout symlinks are refused during explicit enrollment.

To unify another project's files while enrolling it, append
`--project "Example=$HOME/dev/example" --unify-instructions`. This changes only
explicit project roots, not every repository discovered beneath a parent.
Garrison runtimes may set `CODEX_HOME` or `CLAUDE_CONFIG_DIR` to an isolated
home. Pass each confirmed `--codex-home /absolute/runtime/home` or
`--claude-home /absolute/runtime/home` to install the same owned hooks and
managed instructions there as well; preserve its authentication and unrelated
settings. The Codex fitting also projects only these owned hooks and the
managed instruction section at provisioning and before a real CLI launch, so
new named account homes participate. It preserves authentication, all unrelated
settings and MCPs, and existing unowned memory MCP entries. Missing memory MCPs
are initialized from the operator's bridge transport config. An unowned inline
`mcp_servers` table is preserved intact; the helper does not claim to add Basic
Memory inside that closed TOML table. Point each isolated home's Basic Memory MCP to the same authority
through the supported client CLI with that client-home environment selected.

The user-level Claude and Codex instruction files receive the same managed
continuity section; other existing instructions remain intact. Garrison sessions
must load that user configuration (or receive the same owned entries in their
isolated client home) to participate.

Native lifecycle publishing covers Claude Code and Codex CLI hooks. Working
Garrison stretches also use a runtime-neutral gateway bridge, because the SDK's
explicit `settingSources=[]` cannot guarantee native hooks. The gateway reads
cached context with a 500 ms bound, records actual admission, heartbeat and end
metadata, and leaves Basic Memory delivery to the detached worker. Working SDK
duties receive the configured shared Basic Memory MCP in their explicit server
map. In the default composition, only `dispatch-fast` selects the tool-free
`lean` mode; triage and responder use the full SDK mode and retain memory access.
An explicitly configured lean target stays tool-free. Other standalone clients such
as Gemini or Cursor need their own lifecycle integration.

## Activation and verification

Open a new Claude Code or Codex session after installation. Codex discovers hooks
at session start and requires non-managed definitions to be reviewed and trusted;
this installer does not write trust decisions. The active session cannot be
assumed to have reloaded changed hooks. There are six owned events per client,
not the old three. The current hook contract is documented in
[OpenAI's hooks documentation](https://learn.chatgpt.com/docs/hooks).

Check the local bridge and its queue:

```bash
python3 scripts/agent-continuity.py status --cwd "$HOME/dev/garrison"
python3 scripts/agent-continuity.py worker
python3 scripts/agent-continuity.py refresh --cwd "$HOME/dev/garrison"
```

Verify the common MCP by reading the same named topic from each client on each
host, then writing a bounded test note through one and reading it through the
others. Exercise `SessionStart`, `UserPromptSubmit`, `Stop` and `SessionEnd`
with a disposable session and verify its metadata-only checkpoint and roster
in Basic Memory. Confirm failed writes remain private and queued, and that
unrelated hooks are still present. Offline hosts remain unverified until they
reconnect; installed configuration is not proof a real client executed it.

Only after the operator explicitly approves exporting the existing authored
note contents, run `python3 scripts/agent-continuity.py import-native --cwd
"$HOME/dev/garrison"`. Until then, do not run that command or set
`native_import_enabled`; shared topic access and metadata-only hooks work without
exporting the native notes.

The bridge's regression suite uses only the Python standard library:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 tests/agent-continuity.test.py
```

It covers project boundaries and discovery, secret/payload exclusion, private
permissions, client/node separation, peer injection, heartbeat throttling,
missing-end expiry, offline retry, concurrent checkpoint replacement, roster
retry, SSH quoting, hook ownership/idempotency, instruction preservation, native memory
import scope, redaction, update-only behavior and failed-import retry.

Ordinary ChatGPT conversations without this project's files and the Basic
Memory connection cannot acquire local hooks by changing a repository. Use
ChatGPT's connected Codex workspace/remote host for automatic continuity, or
read and update the same shared notes explicitly from a connected chat.
