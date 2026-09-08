# After the ElevenLabs top-up (2026-09-04 08:32 UTC)

Restarted capture-service on this Mac and the mini through
`POST /api/fittings/capture-service/restart` to clear the 15 min Aura park.

| node | `/health voice` | `POST /api/voice/tts` (loopback router) |
|---|---|---|
| goncalos-macbook-pro | `ttsBackend: elevenlabs`, `ttsFallback: null` | 200 audio/mpeg 56886 B 1.52 s |
| goncalos-mac-mini-1 | `ttsBackend: elevenlabs`, `ttsFallback: null` | 200 audio/mpeg 66499 B 1.68 s |
| dev-madrid (pre-D59 code) | `ttsBackend: elevenlabs` (no fallback field) | 200 audio/mpeg 49363 B 1.43 s |

Counters on this Mac after the probe: `tts_generated_elevenlabs` 5,
`tts_fallback_deepgram` 4 (all from the parked window), `tts_quota_exhausted` 2.

## One boot stall, not reproduced

The first post-top-up restart on this Mac (08:26:51 UTC, pid 93320) sat
CPU-bound for about 90 s: `/health` did not answer within 8 s, and every
render inside the process hit `The operation was aborted due to timeout`
(ElevenLabs then Deepgram) while the same endpoints answered curl from a
shell in under half a second. The fallback parked on Aura for 15 min as
designed. The process recovered on its own (state `Ss`, health 3 ms), and
a second restart at 08:32:54 booted clean under a 3 s health/ps watch for
two minutes (`boot-watch.txt`). Cache and record directories are small
(tts-cache 18 files / 280 K, media 37 M), so the stall is not the prune or
the store load. Left as an open observation in the handoff.
