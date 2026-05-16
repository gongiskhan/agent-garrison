# Spike 0.1 — `claude --resume <id> --model <different>` preserves context

**Date:** 2026-05-16
**Conclusion:** Context is preserved across model change. Phase 2.5 proceeds with `--resume` as designed; no fallback to `--continue` is required.

## Method

Headless `--print` invocations against a throwaway cwd at `/tmp/garrison-spike`:

1. `claude --session-id b91bef8a-3e6c-4045-b5e5-8c58acc174ac --model haiku --print --permission-mode bypassPermissions --output-format text "Please remember the secret phrase: 'oryx-42-elephant'. Acknowledge in one short sentence."`
   - Response: `Got it — I've noted the phrase 'oryx-42-elephant'.`
2. `claude --resume b91bef8a-3e6c-4045-b5e5-8c58acc174ac --model sonnet --print --permission-mode bypassPermissions --output-format text "What was the exact secret phrase I asked you to remember in our previous message? Reply with only the phrase."`
   - Response: `oryx-42-elephant`

Two different model aliases (`haiku` → `sonnet`), same `--session-id`, exact-phrase recall on the second invocation. The session JSONL produced by step 1 was loaded by step 2 and the conversation history (including the assistant's acknowledgment) was carried in as context.

## Implication for Phase 2.5

`talk_to(soul, message, worktree_id, tier_hint)` can implement tier-aware respawn by:

1. SIGTERM the existing Claude process bound to `worktree_id` + `soul`.
2. SIGKILL after 3s if still alive.
3. Spawn `claude --resume <existing-session-id> --model <newTier.model> [other tier-derived flags] --print --input-format stream-json --output-format stream-json` (or the equivalent workbench-mode invocation).
4. Feed the new user message into the resumed session.

The user-visible behavior: model and effort flip; conversation history persists. This matches the brief's Step 5 expectation under §"Respawn flow" (worktrees-and-surface-aware-brief.md).

## Caveats noted

- The headless `--print` invocation surfaced the response cleanly; an interactive TUI session also accepts `--resume <id> --model <new>` per `claude --help`.
- The spike used `--permission-mode bypassPermissions` to match Garrison's runtime convention (CLAUDE.md §Permissions).
- The spike did not test `--effort` changes mid-session, only `--model`. Effort changes presumably follow the same path since they're just CLI flags applied at spawn time; if effort respawn misbehaves in Phase 2.5, treat it as an implementation bug, not a brief divergence.
