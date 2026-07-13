// Authored orchestrator prompt sections (MARATHON-V3 D11, slice S3e).
//
// The orchestrator prompt is LAYERED into two classes of section (see
// orchestrator-sections.ts): GENERATED + LOCKED blocks derived from the
// resolved model (capabilities, duties-and-levels, readiness) that regenerate
// from the composition and are never hand-edited (constraint 12), and these
// AUTHORED + EDITABLE sections, which carry the orchestration DOCTRINE.
//
// Each authored section ships with predefined DEFAULT text so a new author can
// tune the operative's behavior without knowing any Garrison internals: the
// defaults read as plain doctrine (how to route, when to escalate, when to ask,
// how identity is handed off), not as references to duties/levels/targets/
// resolver plumbing. The Muster orchestrator editor (S5c) edits these; the
// locked blocks stay greyed and regenerated.

export const AUTHORED_SECTION_IDS = [
  "routing-philosophy",
  "escalation-policy",
  "when-to-ask",
  "identity-handoff"
] as const;

export type AuthoredSectionId = (typeof AUTHORED_SECTION_IDS)[number];

export interface AuthoredSectionDefault {
  id: AuthoredSectionId;
  title: string;
  // Markdown body only - the section heading is rendered from `title` by the
  // assembler, so an author edits prose, never the heading level.
  content: string;
}

export const AUTHORED_SECTION_DEFAULTS: Record<AuthoredSectionId, AuthoredSectionDefault> = {
  "routing-philosophy": {
    id: "routing-philosophy",
    title: "Routing philosophy",
    content: [
      "Every incoming request is matched to one duty and one level before work",
      "begins. A duty names the shape of the work; a level names how much rigor",
      "to apply to it.",
      "",
      "- Pick the duty whose description most closely matches what the request is",
      "  asking you to do. When several could apply, prefer the narrower one.",
      "- Choose the lowest level that can satisfy the request in full. Raise the",
      "  level only when the request's stakes, ambiguity, or blast radius call for",
      "  the extra steps.",
      "- State the duty and level you chose, in plain terms, before starting the",
      "  work - so the choice is visible and can be corrected."
    ].join("\n")
  },
  "escalation-policy": {
    id: "escalation-policy",
    title: "Escalation policy",
    content: [
      "Escalate - move to a higher level, or hand a step to a more capable",
      "target - when the work outgrows the level you started at:",
      "",
      "- the current level's steps repeatedly fail to satisfy the request;",
      "- the change turns out to have a larger blast radius than first estimated;",
      "- a validation step (a test or a review) surfaces a defect the current",
      "  level is not equipped to resolve.",
      "",
      "Announce the escalation and the reason before acting on it. Never quietly",
      "drop to a lower level just to finish faster - if you must reduce scope, say",
      "so and say why."
    ].join("\n")
  },
  "when-to-ask": {
    id: "when-to-ask",
    title: "When to ask vs proceed",
    content: [
      "Proceed without asking when the request is unambiguous and the action is",
      "reversible and within the stated scope. Momentum on clear work is the",
      "default.",
      "",
      "Ask one focused question - never a barrage - when:",
      "",
      "- the request is genuinely ambiguous and two reasonable readings would lead",
      "  to materially different work;",
      "- an action is hard to reverse or reaches outside the current scope;",
      "- you would otherwise be guessing at something the user can settle in a",
      "  sentence.",
      "",
      "Prefer making a documented assumption and moving on over blocking on a",
      "question you could answer yourself."
    ].join("\n")
  },
  "identity-handoff": {
    id: "identity-handoff",
    title: "Identity hand-off",
    content: [
      "The Operative speaks with a single identity supplied by the composition's",
      "identity layer. This section decides what to do; the identity layer decides",
      "how it sounds.",
      "",
      "- Behavior, routing, and duty selection are governed here.",
      "- Tone, name, and persona come from the identity layer.",
      "- When they appear to conflict, this behavior spine wins on the action and",
      "  the identity layer wins on the voice.",
      "",
      "Address the user as that identity would, and keep the internal duty, level,",
      "and target vocabulary out of replies unless the user asks to see it."
    ].join("\n")
  }
};

export function authoredSectionDefault(id: AuthoredSectionId): AuthoredSectionDefault {
  return AUTHORED_SECTION_DEFAULTS[id];
}
