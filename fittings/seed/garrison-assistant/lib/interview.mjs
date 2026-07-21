// interview.mjs — Build-mode interview: an ADAPTIVE questionnaire that asks one
// question at a time and, when it has enough, drafts candidate skills +
// automations and returns them as proposals (the server files them into the
// Improver review queue with provenance `assistant`). Pure logic — no I/O — so
// it is unit-testable; the server drives it and persists the proposals.

// The base prompts. Later questions ADAPT to earlier answers (branch on
// keywords), so the loop is genuinely adaptive, not a fixed script.
const BASE = [
  { id: "daily", q: "What do you do most days in this project — the task you repeat the most?" },
  { id: "byhand", q: "What did you do BY HAND this week that a tool could have done?" },
  { id: "repeat", q: "What multi-step thing do you repeat that always follows the same steps?" }
];

// Given the answers so far, return the next question or signal completion.
// answers: [{ id, text }]. Returns { done:false, question:{id,q} } or
// { done:true, proposals:[...] }.
export function nextStep(answers = []) {
  const answered = new Set(answers.map((a) => a.id));

  // Ask the base questions in order first.
  for (const b of BASE) {
    if (!answered.has(b.id)) return { done: false, question: b };
  }

  // Adaptive follow-up: branch on what they said "by hand".
  if (!answered.has("byhand_detail")) {
    const byhand = (answers.find((a) => a.id === "byhand")?.text || "").toLowerCase();
    let q = "For that by-hand task, what triggers it — a schedule, an event, or you noticing something?";
    if (/test|lint|build|ci/.test(byhand)) {
      q = "For that check, should it run on every commit, on a schedule, or only when you ask?";
    } else if (/report|summar|status|standup/.test(byhand)) {
      q = "For that report, who reads it and how often should it be produced?";
    } else if (/deploy|release|ship|publish/.test(byhand)) {
      q = "For that release step, what has to be TRUE before it's safe to run automatically?";
    }
    return { done: false, question: { id: "byhand_detail", q } };
  }

  // Enough signal — draft candidates.
  return { done: true, proposals: draftProposals(answers) };
}

// Draft at least one SKILL candidate and one AUTOMATION candidate from the
// answers. Deterministic; the server stamps ids/timestamps + provenance.
export function draftProposals(answers) {
  const byId = Object.fromEntries(answers.map((a) => [a.id, a.text || ""]));
  const daily = (byId.daily || "your recurring task").trim();
  const repeat = (byId.repeat || "a repeated multi-step flow").trim();
  const trigger = (byId.byhand_detail || "on demand").trim();
  const byhand = (byId.byhand || "a manual task").trim();

  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";

  const skill = {
    kind: "skill",
    targetClass: "quarters/skill",
    title: `SKILL: ${daily}`,
    claim: `You repeat "${daily}" often and did "${byhand}" by hand — a SKILL that captures the steps of "${repeat}" would let any runtime do it consistently.`,
    draft: {
      name: `assist-${slug(daily)}`,
      description: `Captures the recurring "${daily}" flow so it runs consistently. Drafted by the Garrison Assistant from an interview; review before adopting.`,
      steps: repeat
    }
  };
  const automation = {
    kind: "automation",
    targetClass: "automations/job",
    title: `AUTOMATION: ${byhand}`,
    claim: `"${byhand}" is manual today and should fire ${trigger}. An automation would remove the by-hand step.`,
    draft: {
      name: `auto-${slug(byhand)}`,
      trigger,
      action: `Run the "${byhand}" steps automatically ${trigger}.`
    }
  };
  return [skill, automation];
}
