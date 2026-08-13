# Deviations from the build spec

One line per deviation, with the reason. Details in
[`docs/adr-companion.md`](../../../docs/adr-companion.md).

- `IOS_THING_PATH` was unset at preflight; the reference was located as
  `gongiskhan/ios-thing` on GitHub and cloned to `~/Projects/ios-thing` —
  recorded instead of stopping, since the checkout is byte-identical to what
  the env var would have named.
- The spec's wake phrase "Gary, …" is "Zeca, …" at runtime: the operative was
  renamed mid-run (`b3a82ec3`, 2026-08-13). An address-position gate shipped
  with the rename and was REMOVED the same day (`5d510fb4`, operator's call) —
  the live gate is token-anywhere on word boundaries. Companion fixtures,
  defaults and docs use Zeca and the token-anywhere semantics; the spec text
  is left as history.
- The wake module is consumed as a byte-identical copy with an injected
  source-identity bag (`WakeBus source=`, `MemoryWriter prefix/label`), added
  to omi-channel as behaviour-preserving parameters — hardcoded "omi"
  identities would have violated I2 for companion events. Lockstep guarded by
  `tests/companion-lockstep.test.ts`.
- Spec §4 says video segments are "fragmented MP4 segments in the encoding iOS
  thing already produces" — ios-thing produces NO fMP4 (recon-verified: JPEG
  stills at ~1.5 fps under a proven extension-memory discipline; the
  VideoToolbox import is unused). v1 ships the proven JPEG-frame path with the
  same `{seq, ts, bytes}` framing; the stored frames ARE the spec's "keyframes
  extracted", and no screen-content interpretation happens either way.
- Spec §5 assumed a `match` repo named ios-certificates; ios-thing actually
  stores match assets on its own `match-certs` branch. Garrison cannot copy
  that arrangement because `agent-garrison` is PUBLIC — the M8 lane points
  match at the private `gongiskhan/ios-certificates` repo instead.
- Spec I1 asks to "preserve" triage's wait-for-context hold; no such hold
  exists in today's triage (recon-verified — only batch-overflow carry and the
  wake capture hold exist). M4 ADDS it: capture_events are emitted at session
  end only, and the rule layer holds thin-fragment events below
  `min_transcript_words` without consuming a model attempt.
- Spec §4's "speech delivery over the same socket when a session is live"
  holds for AUDIO-mode sessions only. In screen_audio mode the mic is captured
  by the broadcast extension in a separate process with no AEC coupling to the
  app's speaker, so speech falls through to APNs there (ADR §6).
- The spec's `begin_planning`/`declare_intent` coordination tools are not
  present in this session; the documented fallback discipline applies
  (disjoint files, prompt commits, no whole-tree git operations).
- `docs/adr-companion.md` lives in repo `docs/` as the spec names it, not in
  the fitting's `docs/` as omi-channel's ADR does — the ADR spans `ios/`, this
  fitting and the shared seams, so the repo level is the honest home.
