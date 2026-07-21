// Chat-to-build authoring. Reuses the verified Kanban Discuss -> web-channel
// handoff (mode=james; the gateway reads the mode from the leading "James," and
// IGNORES body.context, so the kickoff message itself carries everything
// load-bearing). "Discuss an automation" opens a James conversation that settles
// the design and writes a brief to ~/.garrison/automations/briefs/<slug>.md; the
// planner (Router-routed) then turns the brief into reviewable steps.

import os from "node:os";
import path from "node:path";

function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value?.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

// Keep the historical, readable "~/.garrison" spelling for the standard
// instance, but emit the exact isolated path whenever either state-root override
// is active. The kickoff is executable agent guidance: leaving the literal
// standard path here caused a secondary instance to write its brief into the
// primary instance even though the Automations store itself was isolated.
export function automationBriefsDir() {
  const explicit = process.env.GARRISON_AUTOMATIONS_DIR?.trim();
  if (explicit) return path.join(expandHome(explicit), "briefs");
  const home = process.env.GARRISON_HOME?.trim();
  if (home) return path.join(expandHome(home), "automations", "briefs");
  return "~/.garrison/automations/briefs";
}

export function automationBriefPath(slug) {
  return path.join(automationBriefsDir(), `${slug}.md`);
}

export function slugify(name) {
  return (name || "automation")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "automation";
}

// A fresh, UNIQUE slug for a NEW (still unnamed) automation design. The Discuss
// thread key AND the brief path both derive from the slug, so a new automation
// must get a distinct slug — otherwise every "+ Discuss an automation" click
// (which carries no name) resolves to the one shared thread `automation-automation`
// + brief `automation.md`. Reopening that existing thread shows its previous
// transcript instead of a fresh conversation and suppresses the kickoff, so a
// single stale/failed design traps every later one. A NAMED automation keeps its
// stable slug so reopening its Discuss returns to the same session on purpose.
export function freshAutomationSlug() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 7);
  return `draft-${t}-${r}`;
}

export function buildAutomationKickoff({ name, slug } = {}) {
  const s = slug || slugify(name);
  const briefPath = automationBriefPath(s);
  // Kept high-level: the planner maps a brief into concrete steps, so the Discuss only
  // needs to settle WHAT + trigger + failure handling (no need to enumerate the engine's
  // step vocabulary or name third-party services here).
  //
  // NOTE on the AUP refusal this Discuss used to hit: the real trigger was EXTENDED
  // THINKING, not the prompt content. This kickoff auto-classified as code/T1-standard
  // → native-sonnet-medium (which injects `/effort medium`), and extended thinking on a
  // "design a process that runs on a trigger" prompt trips Anthropic's usage-policy
  // classifier. The fix is on the routing side: interactive Discuss turns carry a
  // no-thinking classification hint (see web-channel createOrchestratorTransport).
  return [
    "James, let's design an automation together. Match your effort to the work — a simple one needs a light touch, not an interrogation.",
    "",
    name ? `# Automation: ${name}` : "# New automation",
    "",
    "What would you like to automate? Describe it in your own words — what should happen, when it should run, and what to do if a step doesn't work out.",
    "",
    "Give me your read of it, then ask me at least one real, clarifying question before we call it settled — even for a simple automation there's usually something worth confirming (the trigger timing, the inputs, where the output goes, or what 'done' looks like). Ask only what genuinely matters, not a checklist. For an ambiguous one with real branching, dig into the specifics — the inputs, the outline of steps, and how it should behave when something fails.",
    "",
    "IMPORTANT: do not write the brief on your first message — always give me a chance to answer first. Keep your replies short and direct — a few sentences, not an essay; don't narrate.",
    "",
    `Once we've talked it through and it's settled, write the brief to \`${briefPath}\` using the brief template — **what this automates, its trigger, the steps outline, inputs, failure handling, and acceptance** — kept proportional to the work. That brief is the handoff the planner reads. Begin with your read and your question(s).`
  ].join("\n");
}

// The query params the web channel reads (mode + base64 context + kickoff). Used
// for the postMessage("garrison:navigate-fitting") path so the embedded UI can
// ask Garrison's top window to open /embed/<channel>?<params> — a relative or
// own-port URL would resolve against the automations server, not Garrison.
export function buildDiscussParams({ name, slug } = {}) {
  const s = slug || slugify(name);
  const briefsPath = `${automationBriefsDir()}${path.sep}`;
  const context = {
    source: "automations",
    name: name ?? null,
    briefsPath,
    suggestedSlug: s,
    // Absolute path (with ~) to this automation's brief, so the web channel's Brief
    // editor can read/write it directly (confined to ~/**/briefs/*.md server-side).
    briefAbsPath: automationBriefPath(s)
  };
  return {
    mode: "james",
    context: b64(JSON.stringify(context)),
    kickoff: b64(buildAutomationKickoff({ name, slug: s })),
    // Stable thread key per automation so reopening Discuss returns to the same
    // session + history; the channel decodes these like context/kickoff.
    thread: b64(`automation-${s}`),
    // Prominent "Back to Automations" target (the Garrison embed route). The web
    // channel shows a Back button that navigates the top window here.
    returnUrl: b64("/embed/automations"),
    returnLabel: b64("Automations"),
    ...(name ? { title: b64(String(name)) } : {})
  };
}

// Build the web-channel Discuss URL (same shape as kanban-loop/discuss.mjs).
export function buildAutomationDiscussUrl({ name, slug, webChannelBase = "/embed/web-channel-default" } = {}) {
  const s = slug || slugify(name);
  const briefsPath = `${automationBriefsDir()}${path.sep}`;
  const context = {
    source: "automations",
    name: name ?? null,
    briefsPath,
    suggestedSlug: s,
    // Absolute path (with ~) to this automation's brief, so the web channel's Brief
    // editor can read/write it directly (confined to ~/**/briefs/*.md server-side).
    briefAbsPath: automationBriefPath(s)
  };
  const base = webChannelBase.replace(/\/+$/, "");
  const parts = [
    `mode=james`,
    `context=${encodeURIComponent(b64(JSON.stringify(context)))}`,
    `kickoff=${encodeURIComponent(b64(buildAutomationKickoff({ name, slug: s })))}`,
    `thread=${encodeURIComponent(b64(`automation-${s}`))}`,
    `returnUrl=${encodeURIComponent(b64("/embed/automations"))}`,
    `returnLabel=${encodeURIComponent(b64("Automations"))}`
  ];
  if (name) parts.push(`title=${encodeURIComponent(b64(String(name)))}`);
  return `${base}?${parts.join("&")}`;
}
