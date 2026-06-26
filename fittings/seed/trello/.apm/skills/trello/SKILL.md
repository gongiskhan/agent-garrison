---
name: Trello
description: Manage tasks via Trello REST API.
---

# Trello Task Management

Manage tasks via the Trello REST API through this Fitting's Python client.

## Setup

Credentials resolved by the runner from the vault into env:

```
TRELLO_KEY=...
TRELLO_TOKEN=...
TRELLO_BOARD_ID=...
```

`TRELLO_BOARD_ID` comes from the composition's Trello config.

## CLI

The `trello.py` CLI is the cheapest way to interact. It runs from the
Fitting's installed directory (`apm_modules/_local/trello-data-source/`).

```bash
python scripts/trello.py --probe                 # health check
python scripts/trello.py list   <list_id>        # open cards in a list
python scripts/trello.py create <list_id> <name> [desc]
python scripts/trello.py archive <card_id>       # mark done
python scripts/trello.py move    <card_id> <to_list_id>
python scripts/trello.py comment <card_id> <text>
```

For complex flows (label management, board labels lookup, custom
filters), import `TrelloClient` from `scripts/trello.py` directly.

## Task management rules

- **"A Fazer" list** = today's tasks.
- **"Brevemente" list** = soon/later tasks.
- **Done tasks get archived** (`closed=true`), never deleted.
- **Dev tasks** (Indy, CSG, Ekoa, NB, etc.) go under Dev priority.
- When creating a task with a deadline, also create a calendar event.

## Best practices

- Always URL-encode card names with special characters (the
  `TrelloClient` does this for you; raw `curl` calls must use
  `--data-urlencode`).
- Portuguese accents work via the JSON body path used by `TrelloClient`.
- Batch operations: get all cards first, then process.
- For sync: compare local task list with Trello cards to avoid
  duplicates.
