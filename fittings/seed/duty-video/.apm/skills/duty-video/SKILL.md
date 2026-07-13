---
name: duty-video
description: Produce a narrated, captioned video walkthrough of a change. The video-production duty — a thin wrapper that drives the existing walkthrough recorder (playwright-cli capture + ffmpeg stitch + vision self-check) rather than adding a new pipeline. Use when the work needs visual proof it behaves, a demo of a user flow, or a product walkthrough clip.
---

# Video duty

Fulfil the **video** duty: produce a short, narrated, captioned video walkthrough
of a change and hand back one scrubbable link.

This skill owns no recording machinery of its own. It **wraps the `walkthrough`
skill** already installed under `~/.claude/skills/walkthrough` — the recorder that
turns a storyboard into ONE stitched MP4 (playwright-cli capture, ffmpeg stitch,
narration + captions) and then **self-verifies the result via vision on extracted
frames** before publishing it as a Tailscale link. That skill is the single source
of truth for how the video is made; do not duplicate or shell its scripts.

## How to run the duty

1. **Delegate to the `walkthrough` skill.** Invoke it with the change's diff and
   its acceptance context — the same handoff the `garrison-walkthrough` evidence
   step uses. The recorder interviews you for the beats, records them against the
   running app, and asserts on the live UI as it goes.
2. **Let it self-verify.** The recorder reads back extracted frames and confirms
   the video actually shows and labels the right thing. This step is mandatory and
   lives entirely inside the walkthrough skill — you cannot watch video, so never
   skip it or claim success without it.
3. **Return the link.** The recorder publishes the finished MP4 as one scrubbable
   Tailscale URL. That URL is this duty's output.

## Boundaries

- Reference the walkthrough recorder; never rebuild it or edit files under
  `~/.claude/skills/walkthrough`.
- No terminals, shells, or test runners on camera — the walkthrough skill enforces
  this; produce rendered evidence of behaviour, not typing.
- If the change has no observable behaviour to demonstrate, say so and ask rather
  than substituting a test run.
