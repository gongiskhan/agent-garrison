# G1 - the web channel moves into the shell as Conversations (/talk)

Evidence for gate G1 of the Garrison app plan (docs/decisions/2026-09-garrison-app.md,
decisions D2, D10, D16-D19). Files in this directory are produced by the checks
listed below; a check that is not represented here did not run.

| file | what it proves |
|---|---|
| `typecheck.txt` | `npm run typecheck` exit status |
| `vitest.txt` | `npm test` summary (full suite) |
| `playwright-web-channel.txt` | `playwright.web-channel.config.ts` re-pointed at the shell route |
| `live-routes.txt` | `/talk`, `/api/threads`, and a live SSE stream served by the node's app through the `/api` catch-all |
| `tailnet-desktop.png` | `https://<node>/talk` at desktop width, from a non-localhost origin |
| `tailnet-phone.png` | the same route at 390x844 |
| `tailnet-shots.txt` | the geometry behind both screenshots: the shell's `+ New` control vs the conversation bar (clearance), bar height, console errors, cancelled-after-2xx requests |
| `redeploy.txt` | `npm run node:redeploy` tail: build, down, restart, up |
| `composition.txt` | `web-channel-default` unstationed in `compositions/default` and `compositions/openai` |

The two screenshots also drove two fixes that no suite caught: the shell's
`+ New` control overlapped the conversation bar (clearance in
`src/components/talk/talk-page.css`), and the phone bar stacked three rows
(`packages/claude-chat/src/claude-chat.css`, `packages/talk/ui/styles.css`).
`tailnet-shots.txt` is the capture after both fixes.
