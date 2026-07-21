# GARRISON-RUNTIMES-V1 — run passed (8/8 slices, full-bar)

Runtime agnosticism shipped on `main` (`ea871d7..025c6f8`, 33 commits, unpushed):
claude-code is a Runtime Fitting, providers are policy data, primary_runtime is
selectable from the composer with no operative running, and Quarters is
descriptor-driven per runtime — the Claude Code deep surface unchanged.

Sentinels: RUNTIME-CC-FIT-OK · PROVIDERS-POLICY-OK · PRIMARY-SELECT-OK ·
PRIMARY-WIRED-OK · QUARTERS-DESCRIPTOR-OK · QUARTERS-CODEX-GEMINI-OK ·
QUARTERS-SECTIONS-OK · PROJECTION-PRIMARY-OK.

Gates: tsc 0 · lint 0 · full vitest 1972 pass / 0 fail · isolated build green ·
per-slice fresh-context Anthropic review + cross-model Codex pass + independent
test (all needs-work→fixed→re-verified) · ux-qa + 2 verified evidence videos ·
deliberate-red · mutation 8/8 killed · built-in security-review clean · Codex
checkpoint clean.

Needs human eyes: D8 non-PTY interactive turn wiring is future work (degrades
loudly, no crash); 33 commits await the user's push.
