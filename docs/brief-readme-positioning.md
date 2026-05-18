# Brief: Adjust Agent Garrison README with positioning framing

## Goal

Rewrite the project README so that a reader landing on the repo immediately understands **why Agent Garrison exists** and **why someone would choose it over OpenClaw, Hermes, or nano-claw** — the dominant alternatives in the autonomous-agent space.

Keep the README technically accurate (installation, quick start, repo layout, etc. that already exist), but reframe the top of the document around the positioning below. Do not introduce new technical claims that the codebase doesn't back up.

## Positioning thesis

> **Other platforms decide for you. Garrison lets you decide.**

Same functionality as the popular autonomous-agent platforms, but every layer is composable, every decision is yours, and every component is visible.

This thesis should appear at or near the top of the README, expressed in your own clean prose — do not quote it verbatim from this brief.

## Why Garrison (the section to lead with)

Three concrete reasons Garrison exists, which the README should explain plainly:

1. **Control for people who know what they're doing.**
   Practitioners who already have opinions about how agents should behave find OpenClaw, Hermes, and similar platforms too opinionated and too autonomous in directions they didn't ask for. Garrison gives them a thin runtime to compose Faculties and Fittings of their own choosing instead of inheriting someone else's defaults.

2. **Transparency for people who want to understand and customize.**
   Garrison is a thin layer. Most of what an Operative does lives in natural language — skills, prompts, configuration — so it is readable, auditable, and tweakable end-to-end. Nothing important is hidden behind opaque autonomy.

3. **Deployability for people building commercial agents.**
   Because every layer is visible and governable, Operatives built on Garrison can be adopted by businesses that need to understand what their agents are doing. Governance can be layered on. Automation can be introduced progressively — only what the builder chose to automate gets automated.

## APM alignment (must include)

Add a short paragraph — one or two sentences — explaining that Garrison builds on Microsoft's **APM** (Agent Package Manager). APM exists because creating agents is genuinely new: even experienced software developers underestimate the primitives involved (skills, access, channels, memory, orchestration), and there was no NPM-equivalent for that world. APM filled that gap and gained thousands of GitHub stars within days of release. Garrison aligns with APM's vision: it is the thin, composable runtime that takes APM's package model and turns it into running Operatives the builder fully controls.

Tone for this paragraph: factual, not breathless. We are explaining a foundation, not selling it.

## Canonical terminology (use exactly these terms)

- **Garrison** — the platform itself
- **Operatives** — individual agents
- **Faculties** — capability slots (Gateway, Channels, Memory, Skills, Orchestrator, etc.)
- **Fittings** — concrete implementations that fill a Faculty
- **Fittings Registry** — the package registry, built on APM
- **`x-garrison`** — the manifest block name in `apm.yml`

Do not invent synonyms. Do not retrofit older terms (no "components," no "capabilities" as a user-facing word, no "modules"). If the existing README uses any of those, replace them.

## Style and tone

- Direct. Confident. Not breathless and not hype-laden.
- Greenfield framing — do not reference Monstropolis, prior project names, prior tooling, or "version 2" of anything. The README must read as if this is a new, deliberate project.
- The comparison to OpenClaw and Hermes is allowed and useful — name them by name where it sharpens the contrast. Do not disparage them; frame the difference as a choice of design philosophy, not as them being bad.
- Keep "progressive automation" as a phrase or concept: builders choose what to automate, and Garrison automates only what they chose, in the way they chose.

## What to preserve

- Any existing installation steps, quick start commands, and `apm.yml` examples that are technically accurate.
- The license, contributing pointer, and any badges already in place.
- Repository layout descriptions if they exist and are accurate.

## What to remove or rewrite

- Any prior framing language that doesn't match the thesis above.
- Any vague "what Garrison is" prose that doesn't pass the *why-not-just-use-OpenClaw* test.
- Any leftover references to older project names or earlier scope iterations.

## Suggested section order

1. Title + one-line tagline reflecting the thesis
2. Short intro paragraph (3–5 sentences) stating what Garrison is and the core promise
3. **Why Garrison** — the three reasons, as a short subsection each
4. **Built on APM** — the alignment paragraph
5. **Core concepts** — Operatives, Faculties, Fittings, Fittings Registry (one line each)
6. **Quick start / installation** — preserve existing accurate content
7. **Repository layout** — if currently present
8. **Status** — what works today, what's deferred (be honest; cross-session memory and the runtime SDK are deferred)
9. License / contributing pointers

Adjust this order if the existing README has a structure that already works; the priority is that the thesis and the three reasons land in the first screen of reading.

## Verification

After editing, verify:

1. The README opens with the positioning thesis (in your own words) before any installation instructions.
2. OpenClaw and Hermes are named at least once in the **Why Garrison** section.
3. The APM paragraph is present and uses the term "APM" (or "Agent Package Manager" on first mention, then APM).
4. The five canonical terms (Garrison, Operatives, Faculties, Fittings, Fittings Registry) all appear and are used consistently — no stray "components," "capabilities" as user-facing nouns, or "modules."
5. No references to Monstropolis or any prior project name remain.
6. `apm.yml` examples, if present, use the `x-garrison` block name.
7. The Status section is honest about what is and isn't implemented (cross-session memory is not yet implemented; the runtime SDK is deferred).

Report what you changed at a section level when done. Do not commit until I review.
