// Chat-to-build authoring. Reuses the verified Kanban Discuss -> web-channel
// handoff (mode=james; the gateway reads the mode from the leading "James," and
// IGNORES body.context, so the kickoff message itself carries everything
// load-bearing). "Discuss an automation" opens a James conversation that settles
// the design and writes a brief to ~/.garrison/automations/briefs/<slug>.md; the
// planner (Router-routed) then turns the brief into reviewable steps.

function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

export function slugify(name) {
  return (name || "automation")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "automation";
}

export function buildAutomationKickoff({ name, slug } = {}) {
  const s = slug || slugify(name);
  const briefPath = `~/.garrison/automations/briefs/${s}.md`;
  return [
    "James, let's design an automation together — don't jump to code.",
    "",
    name ? `# Automation: ${name}` : "# New automation",
    "",
    "What would you like to automate? Describe the task in your own words — what should happen, on what trigger, and what to do if a step fails.",
    "",
    "Think it through out loud and ask me the clarifying questions you need: which connector(s) it uses (Google / Slack / Trello / …), the rough steps (browser, verify, navigate, wait, local_command, api_call, connector, sub_automation), the inputs it takes, and how it should handle a failure.",
    "",
    `When the design has settled, write the brief to \`${briefPath}\` using the brief template — **what this automates, trigger, connectors, steps outline, inputs, failure handling, acceptance** — that brief is the handoff the planner reads. Begin with your first questions.`
  ].join("\n");
}

// Build the web-channel Discuss URL (same shape as kanban-loop/discuss.mjs).
export function buildAutomationDiscussUrl({ name, slug, webChannelBase = "/embed/web-channel-default" } = {}) {
  const s = slug || slugify(name);
  const context = {
    source: "automations",
    name: name ?? null,
    briefsPath: "~/.garrison/automations/briefs/",
    suggestedSlug: s
  };
  const base = webChannelBase.replace(/\/+$/, "");
  return `${base}?mode=james&context=${encodeURIComponent(b64(JSON.stringify(context)))}&kickoff=${encodeURIComponent(b64(buildAutomationKickoff({ name, slug: s })))}`;
}
