# G2 - one voice layer (capture-service), deepgram-voice retired

Evidence for gate G2 of the Garrison app plan (docs/decisions/2026-09-garrison-app.md,
decisions D3, D5, D22-D31). Files in this directory are produced by the checks
listed below; a check that is not represented here did not run.

| file | what it proves |
|---|---|
| `typecheck.txt` | `npm run typecheck` exit status on the final G2 tree |
| `vitest.txt` | `npm test` summary (full suite, both workspace projects) |
| `playwright-web-channel.txt` | `playwright.web-channel.config.ts` (Conversations in the shell, 3 viewports) |
| `live-routes.txt` | the shell's `/api/voice/{health,stt,tts}` over the tailnet: health `available:true` naming `capture-service`, a real STT transcript, real TTS audio; capture-service :8497 and omi-channel :8494 health; no `deepgram-voice` status file; spawn records with `secretsDelivered`; the vault audit rows for the delivery |
| `ptt-desktop.png` | push-to-talk held in Conversations at desktop width, from a non-localhost origin |
| `ptt-phone.png` | the same hold at 390x844 |
| `ptt-shots.txt` | what the hold did: mic state, panel text, the `/api/voice/stt` call on release, console errors, and the pill/panel geometry |
| `redeploy.txt` | `npm run node:redeploy` tail: build, down, restart, up, tailnet views |
| `state-push.txt` | `compositions/default` and `compositions/openai` pushed to the state service (revisions, readback) |
| `review-summary.md` | the adversarial review of the G2 change set and what each finding became |

The live checks drove one fix outside the plan's scope: the "Notifications
blocked" pill sat on top of the voice panel during a push-to-talk hold (the
pill's offset measured the composer alone, and the panel floats above it).
`packages/talk/ui/composer-inset.ts` now measures the whole stack;
`ptt-shots.txt` is the capture after the fix, with the geometry that proves it.
