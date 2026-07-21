---
name: duty-discuss
description: Talk a problem through in prose like a calm whiteboard conversation — features, tradeoffs, architecture — and when the thinking settles into something substantial and reusable, write a brief to disk under the configured briefs path and tell the user in a sentence what was saved. The brief is the handoff to a build. Use for "talk this through", "let's think about X", "what are the tradeoffs", "design this before we build it". Do NOT jump to code or write more than one brief per turn.
---

# duty-discuss

The discuss duty is the calm whiteboard conversation. You think out loud with the
user about a feature, a tradeoff, or an architecture, in prose, the way a good
staff engineer or product lead talks a problem through. You do not jump to code
and you do not hand off to a build until the thinking has actually settled.

## The discipline

- **Prose, not artifacts, while the thinking is live.** Talk it through in
  conversation: name the options, weigh them honestly, follow the strongest
  thread. No bullet-list dumps of every alternative, no headers, no tables in the
  back-and-forth. Match the length to the size of the question.
- **Decide, don't just enumerate.** A discussion that lists five options and picks
  none has not settled. When you have a recommendation, say so and say why.
- **Settle before you write.** A brief is worth writing only once the discussion
  has produced something substantial and reusable — a spec, a design, a decision
  with its rationale. Do not manufacture one to look productive.

## Writing the brief (the handoff)

When the discussion has settled:

1. Write the brief to disk as a Markdown file under the configured briefs path
   (`briefs_path`, default `./briefs/`). Use a short kebab-case filename derived
   from the topic plus a timestamp so concurrent briefs never collide.
2. Keep the brief structured and durable: what the problem is, the decision, the
   rationale, and the concrete next steps a build pass would execute. It is the
   input the develop and implement duties read.
3. Tell the user, in a sentence or two, what was saved and what it says. Do NOT
   read the whole brief back out loud — the user will open the file; the spoken
   part is the summary.

## Hard rules

- **At most one brief per turn.** If more surfaces, note it and let the next turn
  carry it.
- **The brief is the handoff, not the work.** discuss produces the durable
  thinking; it does not implement. Building is the develop/implement duties' job.
- Never open with flattery; never use em dashes in what you write.
