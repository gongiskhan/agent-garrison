// Prompt composition for the prompt-button pattern.
//
// The viewer is the control surface: a button turns into a prompt that re-invokes
// the same skill in a named mode. Two rules shape every template here:
//
//  1. Never lead with a slash command. Claude Code caps slash-command arguments
//     at ~4000 characters, and a long prompt behind a slash silently truncates.
//     Name the skill in prose instead.
//  2. Reference store paths rather than inlining content. A prompt that pastes
//     findings in full grows without bound; a prompt that names the file where
//     they live stays small and cannot go stale between dispatch and pickup.
//
// Pure: these functions build strings. Dispatch lives in kanban-client.mjs and
// gateway-client.mjs.

export const MODES = [
  "full-run",
  "update",
  "fix-findings",
  "compare",
  "generate-tests",
  "walkthrough",
  "cleanup",
];

const SKILL = "garrison-project-viewer";

function header(mode, { project }) {
  return [
    `Invoke the ${SKILL} skill in mode: ${mode}.`,
    `Project: ${project}`,
    `Viewer data: ${project}/viewer/ (flows/, findings.json, viewer.json)`,
  ].join("\n");
}

export function updatePrompt({ project, flowId = null, reason = "" }) {
  const scope = flowId
    ? `Scope: the flow "${flowId}" only.`
    : `Scope: every flow whose steps a commit has touched since viewer.json's lastRefresh.`;
  return [
    header("update", { project }),
    scope,
    reason ? `Trigger: ${reason}` : "",
    "",
    "Do this:",
    "- Diff from viewer.json lastRefresh.sha to HEAD and rebase every untouched step's anchor, re-verifying its hash.",
    "- Re-narrate ONLY the steps that came back stale or invalidated. Steps that rebase cleanly get re-stamped without a model call.",
    "- Extract every sample mechanically with lib/samples.mjs. Never type code into a manifest.",
    "- Record the new anchor with store.recordRefresh, then POST /api/render to drop the render cache.",
    "",
    "Acceptance: no step is left with a stale badge that a re-narration could have cleared, and every manifest still validates.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function fixPrompt({ project, findings, all = false }) {
  const format = (f) => {
    const where = f.span?.file ? ` (${f.span.file}${f.span.startLine ? `:${f.span.startLine}` : ""})` : "";
    return `- ${f.id} — ${excerpt(f.text, 110)}${where} [flow: ${f.flowId}${f.stepId ? `, step: ${f.stepId}` : ""}]`;
  };

  // Hard budget, not a count cap. A card prompt has a real ceiling, and a run
  // that selected two hundred findings must still dispatch — the ids are the
  // payload that matters, and the full text is one file read away.
  const BUDGET = 2000;
  const lines = [];
  let used = 0;
  for (const f of findings) {
    const line = format(f);
    if (used + line.length + 1 > BUDGET) break;
    lines.push(line);
    used += line.length + 1;
  }
  const omitted = findings.length - lines.length;
  const more = omitted > 0 ? `\n- …and ${omitted} more, listed in viewer/findings.json` : "";

  return [
    header("fix-findings", { project }),
    all ? "Scope: every finding whose status is accepted." : `Scope: the ${findings.length} finding(s) listed below.`,
    "",
    "Findings (full text in viewer/findings.json):",
    lines.join("\n") + more,
    "",
    "Do this:",
    "- Fix the underlying issue for each one. Read the flow first so the fix matches how the code is actually used.",
    "- Run the repo's own gates: npm run typecheck and the relevant tests.",
    "- Set each fixed finding's status to \"fixed\" via store.setFindingStatus.",
    "- Then run mode: update for the affected flows so the viewer shows current anchors.",
    "",
    "Acceptance: gates pass, findings are marked fixed, and the flows they touched re-render without stale badges.",
  ].join("\n");
}

export function generateTestsPrompt({ project, flowId }) {
  return [
    header("generate-tests", { project }),
    `Scope: the flow "${flowId}".`,
    "",
    "Do this:",
    "- Read the flow manifest and find the steps with no test covering them (a flow reaching this button usually has a coverage gap finding).",
    "- Decide per gap whether a drillbook step or a Playwright e2e spec is the right instrument, and say why in one line.",
    "- Write the test so it asserts behaviour a user would notice, not implementation detail. Tests for the sake of coverage are not wanted.",
    "- Run the new test and make it pass against the current code. If it fails because the code is wrong, that is a finding, not a test bug.",
    "",
    "Acceptance: the new test runs green in the repo's own suite, and the flow's coverage-gap finding is closed or restated with what remains uncovered.",
  ].join("\n");
}

export function comparePrompt({ project }) {
  return [
    header("compare", { project }),
    "",
    "Do this:",
    "- Run the static side: enumerate exported symbols and count references, so exports referenced nowhere surface as dead-code candidates.",
    "- Run the runtime side: collect which files and spans actually appear in the runtime captures under the machine-local store.",
    "- Join them into three buckets: dead-code candidates, statically reachable but never observed, and the same job solved differently in different places.",
    "- Write the report to the store as compare-report.json including a copy-pasteable markdown block, then POST /api/render.",
    "- File anything worth acting on as findings with evidence set to static, runtime, or both.",
    "",
    "Acceptance: the /compare page lists real candidates with path:line references, and every claim is traceable to either a reference count or a capture.",
  ].join("\n");
}

export function walkthroughPrompt({ project, sha = null }) {
  // One mode, two scopes. A commit has a name to anchor to; the working tree does
  // not, so its flow is anchored at HEAD and marked dirty — it narrates a moment,
  // goes stale the instant the tree moves, and refresh skips it by design.
  if (!sha) {
    return [
      header("walkthrough", { project }),
      "Scope: the uncommitted changes in the working tree.",
      "",
      "Do this:",
      "- Build a flow whose spine is the working-tree diff hunks, in the order git emits them, using lib/samples.mjs workingTreeDiffSamples. Do not retype any patch.",
      "- Group the hunks into states by theme rather than by file, so the walkthrough reads as a narrative.",
      "- Narrate each hunk: what is changing and why it matters. Fold mechanical hunks into collapsed steps rather than dropping them.",
      '- Anchor the manifest at HEAD with `anchoredAt.dirty: true`, `source: "commit"`, and NO `provenance.commitSha` — there is no commit yet. Say in the summary that this narrates work in progress.',
      "- If the tree is clean, say so and stop: an empty walkthrough is not a flow.",
      "",
      "Acceptance: the pending change reads end to end in the viewer without opening the diff elsewhere, every hunk present somewhere, collapsed or not. Once these changes land as a commit, the real commit walkthrough supersedes this flow.",
    ].join("\n");
  }
  return [
    header("walkthrough", { project }),
    `Scope: commit ${sha}.`,
    "",
    "Do this:",
    "- Build a commit flow whose spine is the diff hunks, in the order git emits them, using lib/samples.mjs commitDiffSamples. Do not retype any patch.",
    "- Group the hunks into states by theme rather than by file, so the walkthrough reads as a narrative.",
    "- Narrate each hunk: what changed and why it matters. Fold mechanical hunks into collapsed steps rather than dropping them.",
    "",
    "Acceptance: the commit reads end to end in the viewer without opening the diff elsewhere, and every hunk of the commit is present somewhere, collapsed or not.",
  ].join("\n");
}

export function fullRunPrompt({ project }) {
  return [
    header("full-run", { project }),
    "",
    "Do this:",
    "- Ask the intake questions first, unless viewer/intake.json already answers them (then confirm reuse in one question).",
    "- Take flow sources in this order: the drillbook, then the e2e tests, then the live UI by vision, then recent commits. Where the drillbook and a test cover the same flow, the drillbook wins.",
    "- Get each spine from execution, not from reading code. A flow with no test is itself a finding.",
    "- Extract every sample mechanically at a pinned SHA. Choose highlights and write descriptions; never type code.",
    "",
    "Acceptance: every manifest validates, every sample verifies by hash, and the index page shows the flows grouped by source.",
  ].join("\n");
}

export function cleanupPrompt({ project }) {
  return [
    header("cleanup", { project }),
    "",
    "This mode is destructive and is never a silent default. Do this:",
    "- Refuse outright unless intake recorded cleanup as armed.",
    "- Propose viewer/cleanup-allowlist.json as an explicit list of paths, each with a reason. Never a glob, and never a *.md pattern.",
    "- Honour the hard exclusions: nothing under fittings/seed/**, .codex/skills/**, site/**, public/icons/**, and never delete README.md, CLAUDE.md or AGENTS.md.",
    "- Consolidate before destroying, through store.consolidateDoc ONLY — it copies the doc into viewer/docs/, records the source hash in docs-manifest.json, and that hash is what the deleter later verifies. Verify each doc renders at /docs.",
    "- Then ask the user to approve the list, and record approvedAt on the allowlist. No approval, no deletion.",
    "- Delete through `node scripts/cleanup.mjs --repo <path> --apply` ONLY — never rm. It re-verifies every gate (armed intake, approved literal allowlist, hard exclusions, consolidated copy whose hash matches the file's current bytes, copy renders) and refuses the whole run if any entry fails. Run it without --apply first and show the dry-run output.",
    "- Keep the deletions out of any feature commit, and do not create a branch unless the user explicitly tells you to.",
    "",
    "Acceptance: every consolidated doc is readable in the viewer before anything is removed, and the removal set equals the approved allowlist exactly — enforced by cleanup.mjs, not by care.",
  ].join("\n");
}

export function askPrompt({ project, flowId, stateIndex, stepId, question }) {
  return [
    `Answer a question about the ${project} project using its Project Viewer analysis.`,
    `Flow: ${flowId}${stepId ? ` · step: ${stepId}` : ""}${
      Number.isInteger(stateIndex) ? ` · state index: ${stateIndex}` : ""
    }`,
    `The manifest is at ${project}/viewer/flows/${flowId}.json — read it, and read the real code at the anchored SHA.`,
    "",
    `Question: ${question}`,
    "",
    "Answer in a few sentences. If the manifest and the code disagree, say so — that is a finding.",
  ].join("\n");
}

/** Build the card/turn payload for a mode. Returns { title, prompt, transport }. */
export function buildDispatch(mode, ctx) {
  switch (mode) {
    case "full-run":
      return { title: "Project Viewer: analyse the project", prompt: fullRunPrompt(ctx), transport: "card" };
    case "update":
      return {
        title: `Project Viewer: update ${ctx.flowId ?? "changed flows"}`,
        prompt: updatePrompt(ctx),
        transport: "card",
      };
    case "fix-findings":
      return {
        title: `Project Viewer: fix ${ctx.all ? "accepted findings" : `${ctx.findings?.length ?? 0} finding(s)`}`,
        prompt: fixPrompt(ctx),
        transport: "card",
      };
    case "generate-tests":
      return {
        title: `Project Viewer: tests for ${ctx.flowId}`,
        prompt: generateTestsPrompt(ctx),
        transport: "card",
      };
    case "compare":
      return { title: "Project Viewer: analysis vs runtime", prompt: comparePrompt(ctx), transport: "card" };
    case "walkthrough":
      return {
        title: ctx.sha
          ? `Project Viewer: walk through ${String(ctx.sha).slice(0, 8)}`
          : "Project Viewer: walk through the uncommitted changes",
        prompt: walkthroughPrompt(ctx),
        transport: "card",
      };
    case "cleanup":
      return { title: "Project Viewer: consolidate docs and clean up", prompt: cleanupPrompt(ctx), transport: "card" };
    case "ask":
      return { title: "Project Viewer: question", prompt: askPrompt(ctx), transport: "chat" };
    default:
      throw new Error(`unknown mode "${mode}"`);
  }
}

function excerpt(text, n) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
