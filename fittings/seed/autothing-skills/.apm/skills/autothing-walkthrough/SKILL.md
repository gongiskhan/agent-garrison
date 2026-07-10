---
name: autothing-walkthrough
model: sonnet
effort: medium
description: Record self-verified video evidence that the current change works by invoking the walkthrough skill with the change's diff and acceptance context, then surface the scrubbable link. In an autothing build a walkthrough STUCK/ask-user return becomes failed-but-unblocking and the run continues; standalone it records the walkthrough and reports (including a STUCK). Use for "record a walkthrough/demo of this", "capture proof it works", or as the evidence step of a build. Delegates to the walkthrough skill (never rebuilds it).
---

# autothing-walkthrough

Records self-verified evidence that the current change works, by invoking the **`walkthrough`** skill (never rebuilding it) with the change's context, and surfacing the scrubbable link. The evidence step of an autothing build, and a standalone "show it working" recorder.

## What it does
Invoke **`walkthrough`** on the change, passing the **diff + task context + acceptance** so its flow selection is accurate. **Always pass `mode: evidence` and the slice's acceptance-criteria list** — evidence mode records one lean per-criterion proof beat each (terse captions, short holds, no story arc, per-beat vision + inline asserts as the gate) rather than a marketing story; see the walkthrough skill's **Evidence mode**. walkthrough owns recording, captions, frame extraction, vision self-verification, its own retry ceiling, honest failure rendering, its notes file, and publishing the Tailscale link + gallery.
- For a **CLI / backend** deliverable with no browser UI, evidence is an `evidence` panel (walkthrough renders the real command's captured output, the resulting file, or the live server log as a clean still with the proving line highlighted) — never a recording of a terminal being typed into.
- For an **event-streamed / dynamic** flow (escalation, an agent run, a live status/progress stream), the capture MUST be a LIVED end-to-end run of that exact flow, not a mechanism proxy or a partial stand-in.
After it returns, **confirm the gallery URL actually resolves** (the serve must be running); (re)start it if down, so the recorded link is live.

## Loop role + output
- **In an autothing build:** a walkthrough **STUCK/ask-user return becomes `video.status: failed-but-unblocking`** — record the STUCK.md path + link (if any), append a blocker to `docs/decisions.md`, and **CONTINUE**; never wait for input. A genuine feature failure that walkthrough renders honestly (`flagged: true`) is recorded, not faked green. **Consume the emitted `evidence.json` into gate-status**: the per-slice `gates.video` records `mode: "evidence"` and an `evidence` pointer to that `evidence.json`, so Validate checks each acceptance criterion against the JSON **without watching the video**. An **`evidence-degraded`** return — a caption/legibility beat that still failed after its one re-record **while its functional `assert` PASSED** — is recorded as `video.status: evidence-degraded` with the reason; the criterion stays proven by its passing assert.
- **Standalone:** record the walkthrough and report the link (rendering a STUCK honestly, not as success).

Print the evidence status in the lead context; a build's terminal verdict counts it in `videos:<verified>/<total>`.
