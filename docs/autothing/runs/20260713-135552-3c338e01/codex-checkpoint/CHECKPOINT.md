# Run-level Codex Checkpoint — 2026-07-13T20:44:25Z
gpt-5.5 high, isolated CODEX_HOME, --sandbox danger-full-access, cross-cutting security scope over bd479dd..HEAD.

## Findings: 4 (3 fixed, 1 accepted) — commit 5dccea0
1. **[FIXED]** openai-agents resolveEndpoint attached the vault key to any openai-compat baseUrl → key exfil to an attacker host if called directly. Now a keyed configurable target whose baseUrl != trusted env OPENAI_BASE_URL drops to keyless. (The bridge already gated the runtime path in S2a; this closes the direct-call path.) Regression test added.
2. **[FIXED]** deepgram-voice WS relay forwarded upstream Error/Warning text verbatim → a misbehaving upstream could echo the DEEPGRAM_API_KEY to the browser. scrubSecret now strips the literal key + Token echo. Regression test added. (HTTP /stt /tts batch error path noted lower-priority — raw upstream pipe, Deepgram does not echo the auth header.)
3. **[FIXED]** runtime-bridge delegate() logged the raw task text to decisions.jsonl → a task with a key/path was persisted. Now redacted (paths + secret tokens stripped, capped). Regression test added.
4. **[ACCEPTED]** openai-agents writeArtifact returns an absolute machine-local path logged in decisions.jsonl. Low severity: a local path in a single-user localhost log; no cross-boundary exposure.

## Verdict: issues-fixed (3 real key/log-leak findings fixed + regression-tested; 1 low-severity accepted).
