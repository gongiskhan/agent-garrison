---
name: discuss-automation
description: Author a Garrison automation by conversation. Use when the user wants to "automate" something, "build an automation", or asks "can you make this run automatically". Opens a Discuss conversation, settles the design, writes a brief, and drives the planner.
---

# Discuss an automation

Author automations the way Kanban cards are discussed — a real conversation, not
a plain-English goal box.

## Flow

1. **Open the Discuss conversation.** The Automations view's "Discuss an
   automation" button opens the web-channel in James mode with the kickoff
   "What would you like to automate?" (built by `lib/discuss.mjs`
   `buildAutomationDiscussUrl`). The gateway reads the mode from the leading
   "James," in the kickoff and ignores `body.context`, so the kickoff carries
   everything.

2. **Converse — ask, don't assume.** Surface the load-bearing decisions and ask
   the user:
   - **Trigger** — manual, cron (`"every weekday 8am"`), webhook (a connector
     event), or listener (poll a connector).
   - **Connectors** — which connected services it uses (Google / Slack / Trello
     / …). If one isn't connected, note it (the run will pause `awaiting_connector`).
   - **Steps** — the rough sequence, using ONLY the 8 step types: `browser`,
     `verify`, `navigate`, `wait`, `local_command`, `api_call`, `connector`,
     `sub_automation`.
   - **Inputs** — what the automation takes (e.g. `recipient_email`).
   - **Failure handling** — what should happen if a step fails (the engine
     self-heals recoverable browser steps; a CAPTCHA/MFA/payment pauses for you).

3. **Write the brief.** When the design has settled, write
   `~/.garrison/automations/briefs/<slug>.md` with: what this automates · trigger ·
   connectors · steps outline · inputs · failure handling · acceptance.

4. **Plan + rehearse.** Hand the brief to the planner (Router-routed, no
   hardcoded model):

   ```
   POST <automations-url>/api/automations/plan-from-brief
        { "briefSlug": "<slug>", "name": "<name>" }
   ```

   It turns the brief into steps, saves the automation, and returns it. The user
   reviews + hand-edits the steps, then runs it — watching each step stream in
   the run viewer (cached/vision tier, live browser stream, self-healing notices,
   per-step feedback).

The plain-English goal textarea is gone; this conversation is how automations are
authored. Steps stay hand-editable afterward.
