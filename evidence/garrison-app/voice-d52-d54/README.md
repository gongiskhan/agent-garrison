# D52 / D53 / D54: dictation language, the two-row composer, the wake hit's conversation

Commit `66042392` on `node/goncalos-macbook-pro` and `main`, 2026-09-03.

## What the phone saw

- Dictation (D49) read as garbage in English: every clip went to Deepgram
  under the server's `pt` pin (`GARRISON_CAPTURESERVICE_STT_LANGUAGE`,
  there so nova-3 hears "Zeca" on the wake lane).
- The message box shared a row with five controls at 390px and showed a
  few words of what was typed.
- REC + "Zeca ..." produced no feedback and nothing in the session, before
  or after stopping the broadcast.

## What changed

- **D52** `packages/talk/ui/voice-clip.ts` appends `?language=` per clip
  (`sttUrlFor`); `voice-conversation.tsx` holds the choice (`en` default,
  `pt`, `multi`) in `localStorage["talk.stt.language"]` and shows an
  EN / PT / Auto switch in the dictation panel. The hint flows through the
  talk router's `/api/voice/stt` to capture-service `POST /stt?language=`
  and `transcribeClip({language})`, which already preferred a per-call
  language over the pin. The wake lane is untouched.
- **D53** `packages/claude-chat/src/ClaudeChat.tsx`: `.cc-composerrow` is a
  column, the textarea alone on top and `.cc-composertools` beneath; a
  `useEffect` on `input` sets the textarea height to its scrollHeight capped
  at `max(120, innerHeight / 2)` (WebKit has no `field-sizing: content`).
  Labels return on every viewport (Route, Dictate, Record, Attach, Send);
  the record button's visible face is Record / Stop while its aria-label
  keeps "Record screen" / "Stop recording".
- **D54** `fittings/seed/capture-service/lib/wake.mjs` binds
  `conversationId` on the wake hit (`handleSegments`) and threads it through
  `close()` and `dispatch()` to `handleCommand()`; `scripts/server.mjs`'s
  `conversationFn` falls back to the persisted `sessions/<id>.json` record
  when the live ingress session is gone.

## Proof

- `vitest.txt`: `tests/capture-service-wake-conversation.test.ts` (9, the
  new case "keeps the conversation bound at the wake hit when the broadcast
  stops before the window closes" fails on the pre-fix `wake.mjs`),
  `tests/voice-clip.test.ts` (49, `sttUrlFor`), and the claude-chat browser
  suites (258 across 13 files in all).
- `webkit-390-composer-empty.png`, `webkit-390-composer-long.png`,
  `webkit-390-composer.txt`: Playwright WebKit 390x844 against this node's
  served build, empty and with ~2000 characters typed; the geometry line
  proves the box stops at half the viewport and the control row stays on
  screen.
- `redeploy.txt`: the `node:redeploy` tail on this Mac (the installed
  capture-service is a copy under `apm_modules/_local`, refreshed by the
  full `up()`).

## Not done

- The phone retest itself (HANDOFF §1 steps 3, 3b, 3c).
- dev-madrid was NOT redeployed: another session's plan ("shells") had
  uncommitted work in its tree at 18:32Z, minutes old, and a redeploy there
  would build that half-done tree and drop its operative. The phone's node
  is dev-madrid; test against this Mac or the mini (node switcher in
  Settings) until dev-madrid picks up `main`.
