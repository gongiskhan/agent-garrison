# Voice pass, 2026-09-03 (D49 composer dictation, D50 REC wake -> conversation turn)

Commit `66c84865`. Decisions D49 and D50 in `docs/decisions/2026-09-garrison-app.md`.

- `vitest.txt`: wake conversation lane (8), ingress incl. the dynamic pendant
  dedupe, dictation helpers (8), voice machine (26). `tsc --noEmit` exit 0.
- `tests/pendant-capture.test.ts` "falls back to the push lane when no session
  can hear" fails under the full parallel run (11s, `spoken` for `push`) and
  passes alone twice (1.1s): load timing, not this change.
- `redeploy.txt`: node:redeploy tail on this Mac, dev-madrid, the mini.
- Live `/health` counters before the redeploy showed
  `screen_audio_transcription_skipped` counting on the old build: the
  broadcast's audio was never transcribed, which is why "Zeca" did nothing.

Phone checks are the operator's (HANDOFF-garrison-app.md items 3 and 3b).
No native change; no TestFlight build in this pass.
