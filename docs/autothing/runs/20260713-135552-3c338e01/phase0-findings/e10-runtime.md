I'll investigate all four findings systematically. Let me start by exploring the relevant fittings and the specific commit, running searches in parallel.
Let me read the key manifests and the commit diff in parallel.
The manifests are rich. Now let me look at implementation details — the agent-sdk runtime scripts, the deepgram server, and the web-channel serving/PWA state.
Let me read the agent-sdk provider table, adapter, and the deepgram/web-channel servers.
Now let me examine the primary-adapter routing, the delegate bridge, the SDK package version, and the deepgram/web-channel servers.
Now the deepgram server (to confirm live WS + TTS streaming), the web-channel server/serve setup, and the delegate() contract. Let me read these.
I have a rich picture. Key correction emerging: the deepgram fitting is NOT batch-only for STT — it already has a live WS `/stream` with interim results, endpointing, and utterance-end. Let me now check the web-channel UI (PWA manifest, service worker, getUserMedia/AudioWorklet, whether the browser actually uses the live stream) and load web-search tools for the SDK/VAD facts.
The active UI (`claude-chat`) does batch push-to-talk; the live WS streaming client lives only in `legacy-voice.tsx` (using deprecated `ScriptProcessorNode`, not AudioWorklet). Let me confirm PWA head tags, the build, the primary-adapter resolver, and run the web searches for the OpenAI SDK and VAD facts.
Let me read the `resolvePrimaryAdapter` function to confirm the agent-sdk primary path, and run the remaining web searches for E17 (silero-vad, onnxruntime-web) and the OpenAI SDK license/baseURL.
Let me confirm the licenses precisely (VAD showed ISC, not MIT) and the OpenAI Agents SDK baseURL/tool model from GitHub, which WebFetch can access.
Good — E17 essentially resolved (VAD is ISC, onnxruntime-web is MIT). Let me nail two last things for E10: the OpenAI Agents SDK's custom-endpoint mechanism, and Garrison's `delegate()`/RuntimeAdapter contract that a new runtime must implement.
Let me read the `delegate()` contract and the RuntimeAdapter interface header to complete the bridge picture for E10.
I have complete evidence for all four findings. Here is the structured report.

---

## FINDING-E10 — agent-sdk-runtime today + OpenAI Agents SDK as a candidate

### (a) The agent-sdk-runtime fitting as it stands

**Provider table** — `fittings/seed/agent-sdk-runtime/lib/providers.mjs:20-90` (`SDK_PROVIDERS`). Six providers, each with a capability record and auth mode:

| provider | baseUrl | auth | capabilities | effort |
|---|---|---|---|---|
| `anthropic` | none (OAuth) | subscription (Max) | FULL (text, tool, image, doc, webSearch, mcp) | yes |
| `ollama-local` | `http://localhost:11434` | local (dummy token `ollama`) | text+tool+mcp | no |
| `zai-glm` | `https://api.z.ai/api/anthropic` | `ZAI_API_KEY` | text+tool+mcp | no |
| `deepseek` | `https://api.deepseek.com/anthropic` | `DEEPSEEK_API_KEY` | text+tool ONLY | no |
| `minimax` | `https://api.minimax.io/anthropic` | `MINIMAX_API_KEY` | text+tool ONLY | no |
| `llm-proxy` | configurable per-target | `LLM_PROXY_API_KEY` | text+tool default (overridable) | no |

Model is free-text per spawn (an Ollama tag, a GLM/DeepSeek slot, or anything a proxy fronts). `llm-proxy` is the "new-model day-one" escape hatch (LiteLLM etc.), with a supply-chain guard forbidding LiteLLM 1.82.7/1.82.8 (`providers.mjs:224-249`).

**Base-URL handling** — the whole runtime is built on the **Anthropic-compatible** env contract (`apm.yml:49-53`: `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `GARRISON_MODEL`). `buildSdkEnv` (`providers.mjs:135-171`) strips inherited `ANTHROPIC_*` first (the MiniMax-precedence trap), then sets base URL + `ANTHROPIC_AUTH_TOKEN`; the `anthropic` path forces `ANTHROPIC_API_KEY=""` (so it never bills the API pool) and uses no base URL (OAuth). SDK pinned: `@anthropic-ai/claude-agent-sdk@0.3.179` (`package.json`), imported only in `lib/sdk-client.mjs`. The adapter (`lib/agent-sdk-adapter.mjs`) reads the SDK's structured message stream directly — no PTY, no terminal scraping — and caps `maxTurns` (default 12) + optional token budget since SDK sessions have no default turn limit.

**Can it serve as PRIMARY?** Yes. `resolvePrimaryAdapter` in `fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs:904-949` handles `engine === "agent-sdk"`: it lazy-imports `AgentSdkAdapter`, defaults `provider` to `"anthropic"` when the operative spawn config names none (byte-identical Max path), and honors a non-anthropic provider with its `baseUrl` + vault `secrets` — so a free local-ollama operative is a supported primary. It also reads the assembled system prompt as an **in-memory string** (`appendSystemPrompt`), not a file path, because the SDK takes `systemPrompt.append`. `agent-sdk` is in `KNOWN_PRIMARY_ENGINES` (`gateway-routing.mjs:837`).

**The a3e4d21 fix** — `git show a3e4d21`: `gateway-pty.mjs` (the entrypoint) never threaded `GARRISON_PROVIDER` into `operativeSpawnConfig`, so an agent-sdk **primary** on a non-Anthropic provider resolved its spawn config with `provider` defaulted to `"anthropic"`. The endpoint was still correct (the process-env `ANTHROPIC_BASE_URL` fence from `providerLaunch` is inherited by the SDK), so this was a **wrong-capability-profile + inheritance-reliant fence, not a hard endpoint leak** — and the routed/probe path (`route.target.provider`) was already correct. The fix adds `PRIMARY_SDK_PROVIDER` (mapping the runner's `"anthropic-plan"` launch spelling → SDK key `"anthropic"`) and threads it into `operativeSpawnConfig.provider`. Regression test `tests/gateway-runtime-adapter-routing.test.ts` locks both directions (ollama-local threaded through; anthropic default preserved). The commit note flags the gap survived because WS2c's matrix exercised claude-code/codex/opencode primaries, not agent-sdk-as-primary.

### (b) OpenAI Agents SDK as a new runtime

- **Package / license:** `@openai/agents` (openai-agents-js), latest 0.12.0, **MIT** license. `npm i @openai/agents`.
- **Base-URL override:** **clean and first-class** — `setDefaultOpenAIClient(new OpenAI({ baseURL, apiKey }))` + `setOpenAIAPI('chat_completions')`; documented for Ollama (`http://localhost:11434/v1/`), vLLM, Azure, and custom `ModelProvider`. This is an **OpenAI-compatible** contract, complementary to Garrison's current Anthropic-compatible-only providers table — it would reach OpenAI-native and `/v1/chat/completions` endpoints the agent-sdk runtime can't.
- **Tool model:** Agents = LLM + instructions + tools; tools are typed functions, plus MCP servers, hosted tools, agents-as-tools/handoffs, and guardrails; the SDK runs its own agentic loop.
- **Bridge to Garrison's `delegate()`:** A new runtime implements the `RuntimeAdapter` contract (`packages/claude-pty/src/runtime-adapter.mjs:28-37`, `ADAPTER_METHODS`: spawn / awaitReady / sendTurn / awaitResponse / setModel / setEffort / resume / teardown) — exactly what `AgentSdkAdapter` does. `delegate()` (`packages/claude-pty/src/runtime-bridge.mjs:70-132`) is dependency-injected and calls spawn→awaitReady→sendTurn→awaitResponse→teardown, returns `{summary, artifacts[]}` (validated, retry-once, logged to `decisions.jsonl`). An `openai-agents` adapter would wrap the SDK's `run()` result inside `awaitResponse` (structured, no scraping — the AgentSdkAdapter is the template), carry its own providers table keyed on `OPENAI_BASE_URL`/`OPENAI_API_KEY`, and declare `provides: runtime name: openai-agents`. Secondary use is automatic via `bridge.mjs`; primary use needs a `KNOWN_PRIMARY_ENGINES` + `EXEC_PRIMARY_ADAPTER_CLASS` entry (`gateway-routing.mjs`).

---

## FINDING-E15 — deepgram-voice today

**(a) Premise correction: it is NOT batch-only.** STT already runs in **both** modes:
- Batch: `POST /stt` — single Deepgram `/v1/listen` call (`fittings/seed/deepgram-voice/scripts/server.mjs:284-326`).
- **Live WS `/stream`** (`server.mjs:384-468`, `attachStream`) relays browser PCM (linear16 mono, client-supplied sample rate) to Deepgram's live `wss://api.deepgram.com/v1/listen` with `interim_results=true`, `endpointing=300` (ms), `utterance_end_ms` (client-configurable 1000-20000, default 5000), `vad_events=true`, punctuate, smart_format. It emits a stable client protocol: `ready` / `speech_started` / `transcript{text,isFinal,speechFinal}` / `utterance_end{accumulated finals}` / `error`. So interim results, endpointing, and utterance-end **already exist server-side** and are documented in `apm.yml:76-88`.

**TTS is still batch-only:** `POST /tts` → single `/v1/speak` fetch returning the full audio buffer (mp3/wav), model `aura-asteria-en` (`server.mjs:328-372`). No streaming (aura WS) TTS.

**The gap:** the **active** web UI (shared `@garrison/claude-chat`, `packages/claude-chat/src/ClaudeChat.tsx`) uses only **batch** push-to-talk (`MediaRecorder` → `POST /voice/stt`) + batch read-aloud (`/voice/tts`). The live-WS client exists only in `fittings/seed/web-channel-default/ui/legacy-voice.tsx` (preserved, not the active UI — `apm.yml` for_consumers, "future voice re-integration via composerAdornment"). The web-channel server relays the live stream at `/api/voice/stream` (`web-channel-default/scripts/server.mjs:216-237, 855-870`), but nothing in the current UI connects to it. **Live STT is plumbed end-to-end server+relay, but not wired into today's chat UI.**

**(b) Vault key never reaches the browser.** `DEEPGRAM_API_KEY` is read server-side (`server.mjs:42`; `secret_scope` in `apm.yml:50-51`), injected from the vault by the runner for own-port fittings that `consumes: vault` (referenced as `src/lib/own-port-lifecycle.ts vaultEnvForEntry`). Browser talks only to the web-channel same-origin proxy (`handleVoiceProxy` for /stt+/tts, `relayVoiceStream` for the WS); the voice server returns 503 when the key is absent.

**(c) What a full "live STT relay + streaming TTS" upgrade needs:** live STT relay is already built — the remaining work is (1) wiring the existing `/api/voice/stream` into the active claude-chat UI (currently legacy-only) with a modern **AudioWorklet** capture path (legacy uses the deprecated `ScriptProcessorNode`, `legacy-voice.tsx:220,320-345`); and (2) **streaming TTS** — Deepgram aura offers a TTS WebSocket (`wss /v1/speak`, streamed text-in / audio-out) the current batch `/tts` doesn't use; that needs a new WS endpoint on the voice server, a matching relay on the web-channel, and a browser audio-playback queue.

---

## FINDING-E16 — web-channel client audio on iPhone over Tailscale

**(a) Serve setup:** HTTP by default on port **7083**, bind `127.0.0.1` (`web-channel-default/apm.yml:16-24`; `server.mjs` parseArgs). Optional TLS via `tls_cert`+`tls_key` config → HTTPS (`server.mjs:782-791, 847-849`). Serves the static React bundle from `dist/`.

**(b) Audio capture does NOT work over Tailscale today by default.** `getUserMedia`/`AudioWorklet` require a **secure context**; the active claude-chat guard is explicit — `if (!navigator.mediaDevices?.getUserMedia) setVoiceError("Microphone needs a secure context (https or localhost)")` (`ClaudeChat.tsx:933-938`). Over Tailscale you reach `http://<tailscale-ip-or-MagicDNS>:7083`, i.e. plain HTTP on a non-localhost host → not a secure context → mic blocked. Two fixes, both already anticipated in the code: set `tls_cert`/`tls_key` for in-app HTTPS, or run `tailscale serve` for a managed cert (`https://host.ts.net`) — `apm.yml:29-36` explicitly recommends `tailscale serve` and calls the in-app TLS the fallback. Note the active UI captures via **`MediaRecorder`** (batch), not AudioWorklet; the only AudioContext path is legacy-voice's deprecated `ScriptProcessorNode`. **There is no AudioWorklet anywhere in the fitting.**

**(c) PWA state: NOT an installable PWA.** No `manifest.json` and no service worker exist (confirmed by find/grep and by `ui/build.mjs`, which emits neither). `ui/index.html` carries only `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, and `theme-color` meta tags (`index.html:5-8`) — enough for an iOS "Add to Home Screen" fullscreen webclip, but no web app manifest, no offline/service-worker support, and not Android-installable.

---

## FINDING-E17 — silero-vad in the browser (brief)

- **Package:** `@ricky0123/vad-web` (latest ~0.0.30). **License: ISC** — correcting the assumed MIT; ISC is a permissive, MIT-equivalent, OSI-approved license (fine for this project). Runs **Silero VAD v5** via onnxruntime-web.
- **Model/bundle size:** `silero_vad_v5.onnx` ≈ **2.33 MB**; ships `vad.worklet.bundle.min.js` (it uses an **AudioWorklet**) plus ORT wasm files that must be served alongside.
- **onnxruntime-web license:** **MIT** (Microsoft). `ort.all.min.js` is >500 KB JS; the wasm can be trimmed toward ~3 MB via a minimal build / conditional `onnxruntime-web/wasm` import.
- **Mobile CPU:** Silero v5 is tiny and runs in an AudioWorklet off the main thread — real-time and cheap on modern iPhones; the real mobile cost is one-time WASM warmup plus the ~2.3 MB model + ORT bundle download. Feasible as a browser wake/endpoint gate.

---

**Key files for follow-up (all absolute):**
- `/home/ggomes/dev/garrison/fittings/seed/agent-sdk-runtime/lib/providers.mjs` (provider table + env building)
- `/home/ggomes/dev/garrison/fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs`, `.../scripts/bridge.mjs`, `.../package.json`
- `/home/ggomes/dev/garrison/fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs` (`resolvePrimaryAdapter` :895-949) and `.../scripts/gateway-pty.mjs` (the a3e4d21 fix)
- `/home/ggomes/dev/garrison/packages/claude-pty/src/runtime-adapter.mjs`, `.../runtime-bridge.mjs` (adapter contract + `delegate()`)
- `/home/ggomes/dev/garrison/fittings/seed/deepgram-voice/scripts/server.mjs` (batch /stt+/tts + live WS /stream)
- `/home/ggomes/dev/garrison/fittings/seed/web-channel-default/scripts/server.mjs`, `.../ui/index.html`, `.../ui/build.mjs`, `.../ui/legacy-voice.tsx`
- `/home/ggomes/dev/garrison/packages/claude-chat/src/ClaudeChat.tsx` (active voice = batch push-to-talk, secure-context guard)
