---
name: Outpost Actions
description: Invoke operations on remote Garrison outpost machines over the outpost bridge.
---

# Outpost Actions

Run commands, read/write files, and list directories on remote Mac machines
connected as Garrison outposts.

## When to use

When the principal asks you to do something on a specific remote machine
("run X on development", "what's in ~/Projects on development", "check the
logs on the staging machine"). Always call `list_outposts` first to confirm
the machine name and connection status before attempting any remote operation.

## CLI

```bash
python3 apm_modules/_local/outpost-actions/scripts/outpost.py list_outposts
python3 apm_modules/_local/outpost-actions/scripts/outpost.py run_on <machine> <cmd...> [--timeout-ms N]
python3 apm_modules/_local/outpost-actions/scripts/outpost.py read_file_on <machine> <path>
python3 apm_modules/_local/outpost-actions/scripts/outpost.py write_file_on <machine> <path>  # content on stdin
python3 apm_modules/_local/outpost-actions/scripts/outpost.py list_files_on <machine> <path>
```

## Output

All subcommands print JSON to stdout on success:

- `list_outposts` → `{"outposts": [{"name": "...", "connected": true, ...}]}`
- `run_on` → `{"stdout": "...", "stderr": "...", "exit_code": 0}`
- `read_file_on` → `{"content": "..."}`
- `write_file_on` → `{"ok": true}`
- `list_files_on` → `{"entries": [{"name": "...", "type": "file|directory|symlink"}]}`

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | success |
| 2 | unknown outpost — machine not in registry |
| 3 | outpost offline — machine known but not connected |
| 4 | bridge RPC error |
| 5 | outpost-host unreachable (127.0.0.1:3702) |

## Operating principles

- Call `list_outposts` first. Never guess machine names.
- `run_on` is blocking. For commands that may take over 30 s, pass `--timeout-ms <ms>`.
- Paths on the remote machine may use `~` (the bridge expands against the remote user's home).
- If exit 2: tell the principal which machines are available.
- If exit 3: tell the principal the machine is offline; suggest checking Workbench → Outposts.
- If exit 5: the outpost-host may not be running; tell the principal to start Garrison.
