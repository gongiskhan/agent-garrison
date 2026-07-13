# Voice - attended device checklist (iPad + iPhone over Tailscale)

The owner runs this by hand on **real devices over Tailscale**. It covers exactly
the things automated tests (Playwright, unit) **cannot** verify: real microphone
capture, real Deepgram STT/TTS latency, barge-in feel, and PWA install. It is
**additive and non-gating** - the voice slice can ship with this marked
`ATTENDED-PENDING`; run it before relying on phone voice in earnest.

Print this page (or open it on a laptop) and tick each box on **both** devices.

---

## Preflight (once, from the machine running Garrison)

- [ ] The composition is **up** and `deepgram-voice` is stationed and running
      (the web-channel UI shows the mic button - hidden when no voice Fitting runs).
- [ ] Get the secure https URL:
      `node fittings/seed/web-channel-default/scripts/secure-context.mjs --check`
      → note the `tailnet URL` it prints. If it reports NOT available, run
      `... secure-context.mjs --serve` (needs Tailscale signed in), then re-check.
- [ ] Both the iPad and the iPhone are on the **same tailnet** as the machine.

Secure-context URL to use on the phones: `___________________________________`

---

## Run on EACH device (iPad, then iPhone)

### A. PWA install

- [ ] Open the https tailnet URL in Safari. The page loads (chat surface visible).
- [ ] Share → **Add to Home Screen**. The icon shown is the Garrison "G" on the
      dark badge (not a blurry screenshot thumbnail).
- [ ] Launch from the home-screen icon. It opens **standalone** (no Safari address
      bar / tab bar).
- [ ] The status bar / title reads "Operative"; theme colour is the cream tone.

### B. Secure context / mic permission

- [ ] The mic button is **enabled** (not greyed out). If greyed, the origin is not
      a secure context - recheck preflight (you must be on the https tailnet URL,
      not a `http://100.x.x.x` or `http://<lan-ip>` address).
- [ ] First mic tap prompts for microphone permission; **Allow**.

### C. Real mic capture + live STT

- [ ] Tap the mic and speak a full sentence. A live "Listening…" indicator with a
      **level meter** reacts to your voice.
- [ ] Stop speaking. Deepgram's silence endpointing ends the utterance on its own
      (you do **not** press stop).
- [ ] The transcript is accurate and appears with acceptable latency (interim words
      show while you speak; final text settles within ~1s of you stopping).
- [ ] With **Auto-send ON**, the finished transcript sends automatically. With it
      **OFF**, the transcript fills the composer for review instead.

### D. Read-aloud (TTS)

- [ ] Tap the **speaker** button on a reply - it reads that reply aloud clearly.
- [ ] Turn **Read-aloud** on - every completed reply auto-speaks. TTS latency to
      first audio is acceptable (speaking starts within ~1-2s of the reply settling).

### E. Barge-in + hands-free feel

- [ ] Turn **Hands-free** on (this also enables Read-aloud). After a spoken reply
      there is a visible "~2s Listening in Ns…" countdown, then the mic re-opens
      with the live "Listening…" meter.
- [ ] The mic **never** opens while the agent is still speaking.
- [ ] Barge-in: while the agent is speaking, tapping the mic **aborts/interrupts**
      cleanly and starts listening.
- [ ] Loop safety: stay silent (ambient room noise only) after a reply - it does
      **not** auto-send an empty/garbage turn; the mic closes or waits without firing.

### F. Robustness

- [ ] Lock the phone mid-reply, unlock - the session/transcript is intact on return
      (turns persist server-side).
- [ ] Backgrounding the PWA and returning does not wedge the mic or audio.

---

## Result

| Device  | Installed | Mic works | STT latency OK | TTS OK | Barge-in OK | Hands-free OK |
|---------|-----------|-----------|----------------|--------|-------------|---------------|
| iPad    |           |           |                |        |             |               |
| iPhone  |           |           |                |        |             |               |

Notes / anything that felt off (be picky - latency spikes, clipped audio, mic that
opens into noise, icon rendering):

```
```

If everything above ticks, mark the voice slice `ATTENDED-VERIFIED`. Otherwise file
the specific failures back to the voice implementation.
