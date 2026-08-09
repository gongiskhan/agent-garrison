import type { RouteAttribution } from "./transport";

// The Turn Rail's badge model, kept PURE so the same list drives the settled rail,
// the in-flight rail, the persisted-history rail and the unit tests, with no React
// and no DOM in sight.
//
// The one rule the whole model exists to enforce: a dimension the lane could not
// report has NO badge. Not "unknown", not "-", not a greyed placeholder. A rail
// that invents a value is worse than a rail that is short, because the user acts on
// it (they pick a project, they blame a model). The two deliberate exceptions are
// both cases where the ABSENCE is itself the fact:
//   • `account: null` -> "machine login" (there is no named account; the turn ran on
//     the machine's own Claude login);
//   • `skill: null` with a known duty -> "skill: none" (no duty-* fitting is
//     stationed in any live composition, so every live cell has a null skill -
//     see the "Honest limits" section of the 2026-07-25 decision).
// `undefined` still means "not reported" for both, and still omits the badge.

/** Tone drives colour only; the label must stand alone without it. */
export type RailBadgeTone = "warn" | "dim" | "link";

export interface RailBadge {
  /** Stable identity - the rail keys its dropdown and its React list on this. */
  key: string;
  /** The visible text. Short, mono, lowercase-ish: this sits in a scrolling line. */
  label: string;
  /** The full truth behind the label, shown as the badge tooltip. Never empty. */
  title: string;
  tone?: RailBadgeTone;
  /** Present only on a badge that navigates (the carded-work board link). Already
   *  host-rewritten by the producer - see RouteAttribution.cardUrl. */
  href?: string;
  /** Present only on a badge that triggers an in-app drill-down. */
  action?: "transcript";
}

/** Whether the requested effort actually reached the runtime. Null when no effort
 *  was requested at all. Shared by the rail and the legacy routing chip so the two
 *  renderings can never disagree about the SEMANTICS (only about wording). */
export type EffortState = "applied" | "refused" | "unverified";
export function effortState(route: RouteAttribution): EffortState | null {
  const effort = str(route.effort);
  if (!effort) return null;
  if (route.effortApplied === true) return "applied";
  if (route.effortApplied === false) return "refused";
  return "unverified";
}

/** Trim-and-normalise: anything non-string (null, undefined, a stray number) reads
 *  as absent, which is what every omission check below tests for. */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** A finite integer level, or null. `level: 0` is not a real duty level. */
function lvl(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : null;
}

/** Join tooltip clauses, dropping the empty ones. */
function title(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" - ");
}

/**
 * Build the ordered badge list for one turn's resolved attribution.
 *
 * Order is meaning-first, provenance-last: WHAT was asked of the agent (duty,
 * skill), WHAT ran it (runtime, model, effort, account, project), then HOW it was
 * chosen (target), then the exceptional states (card, stopped) and the drill-downs
 * (transcript, override). A user scanning left to right hits the fields they are
 * most likely to want to change first.
 *
 * Pure: same input, same output, no clock, no environment.
 */
export function railBadges(route: RouteAttribution): RailBadge[] {
  const badges: RailBadge[] = [];

  const duty = str(route.duty);
  const level = lvl(route.level);
  const phase = str(route.phase);
  if (duty) {
    // preRouteV4 defaults the phase to the duty itself, so a phase EQUAL to the
    // duty carries no information and is dropped. A phase that differs is the
    // ladder step actually running, and reads as a path fragment: "plan L2 /review".
    const stepped = phase && phase !== duty ? ` /${phase}` : "";
    badges.push({
      key: "duty",
      label: `${duty}${level ? ` L${level}` : ""}${stepped}`,
      title: title(
        `duty ${duty}`,
        level ? `level ${level}` : null,
        phase ? `phase ${phase}` : null,
        str(route.via) ? `chosen via ${str(route.via)}` : null
      ),
    });
  }

  const skill = str(route.skill);
  if (skill) {
    badges.push({ key: "skill", label: `skill: ${skill}`, title: `duty skill ${skill}` });
  } else if (duty && route.skill == null) {
    // `== null` deliberately, covering undefined as well as an explicit null. The
    // gateway sends `skill: null`, but the thread store drops explicit nulls (null
    // and absent mean the same "omit" everywhere else in this contract), so a strict
    // `=== null` made this badge appear on a live turn and vanish on the same turn
    // after a reload. A known duty with no bound skill is a fact worth stating in
    // both states. A non-null, non-string skill is malformed rather than "none", so
    // it falls through to no skill badge at all.
    badges.push({
      key: "skill",
      label: "skill: none",
      title:
        "no duty skill fitting is stationed - this duty's behaviour comes from the composition's inline definition",
      tone: "dim",
    });
  }

  const runtime = str(route.runtime);
  if (runtime) {
    badges.push({ key: "runtime", label: runtime, title: `runtime ${runtime}` });
  }

  const model = str(route.model);
  if (model) {
    // The provider rides in the model's tooltip rather than getting its own badge:
    // it is never independently settable (a target picks runtime+provider+model
    // together) so a separate badge would be a dropdown that cannot open.
    const provider = str(route.provider);
    badges.push({
      key: "model",
      label: model,
      title: title(`model ${model}`, provider ? `provider ${provider}` : null),
    });
  }

  const effort = str(route.effort);
  const eState = effortState(route);
  if (effort && eState) {
    // Requested effort is NOT the same as applied effort: providers.mjs marks
    // effort:false for every non-Anthropic provider and gemini has no effort
    // control at all, so a bare "high" would be a lie on most lanes.
    const label =
      eState === "applied" ? effort : eState === "refused" ? `${effort} (not applied)` : `${effort} (unverified)`;
    badges.push({
      key: "effort",
      label,
      title:
        eState === "applied"
          ? `effort ${effort}: applied by the runtime`
          : eState === "refused"
            ? `effort ${effort}: this provider has no effort control, so it was not applied`
            : `effort ${effort}: requested, but the runtime did not report whether it applied`,
      ...(eState === "refused" ? { tone: "warn" as const } : {}),
      ...(eState === "unverified" ? { tone: "dim" as const } : {}),
    });
  }

  const account = str(route.account);
  const accountSource = str(route.accountSource) ? `source ${str(route.accountSource)}` : null;
  if (account) {
    badges.push({ key: "account", label: account, title: title(`account ${account}`, accountSource) });
  } else if (route.account === null) {
    // Explicit null is a fact, not an absence: no named account was selected, so
    // the turn authenticated as whatever the machine itself is logged in as.
    badges.push({
      key: "account",
      label: "machine login",
      title: title("no named account - the turn ran on this machine's own Claude login", accountSource),
      tone: "dim",
    });
  }

  const project = str(route.project);
  if (project) {
    // projectPath is tooltip-only. It is an absolute machine-local path, so it must
    // never become an href.
    const projectPath = str(route.projectPath);
    badges.push({
      key: "project",
      label: project,
      title: title(`project ${project}`, projectPath ? `cwd ${projectPath}` : null),
    });
  }

  // Tier IS settable now (it is half the {taskType, tier} key the matrix resolves
  // on), so it earns a badge of its own rather than living only in the target
  // tooltip. The task type stays tooltip-only: `duty` is the settable spelling of it.
  const tier = str(route.tier);
  if (tier) {
    badges.push({
      key: "tier",
      label: tier,
      title: title(
        `tier ${tier}`,
        str(route.taskType) ? `task type ${str(route.taskType)}` : null,
        route.classifierSkipped === true ? "no classifier ran - it was chosen explicitly" : null
      ),
    });
  }

  // The phase plan. Reported only for a run that HAS one (a carded run); a plain
  // conversational turn walks no pipeline, so the badge is absent rather than
  // claiming an empty plan.
  //
  // Either half is enough to badge. When the orchestrator infers the plan from the
  // tier there IS no flow - the plan is not one of the named kinds - so the
  // label falls back to the OFF count. Requiring `flow` would blank the badge on
  // exactly the auto turns it exists to explain.
  const flow = str(route.flow);
  const off = str(route.phasesOff)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (flow || off.length) {
    badges.push({
      key: "flow",
      // The OFF count rides the label because it is the part that changes what
      // actually runs - a plan silently missing two gates is the failure this
      // badge exists to prevent.
      label: flow ? (off.length ? `${flow} -${off.length}` : flow) : `plan -${off.length}`,
      title: title(
        flow ? `flow ${flow}` : "plan inferred from the tier",
        off.length ? `phases off: ${off.join(", ")}` : "every phase in the plan runs"
      ),
      ...(off.length ? { tone: "warn" as const } : {}),
    });
  }

  const target = str(route.route);
  if (target) {
    // Tier/task-type/honored were visible on the old routing chip - keep them in the
    // target tooltip too so the classification stays inspectable from either badge.
    badges.push({
      key: "target",
      label: target,
      title: title(
        `target ${target}`,
        str(route.ruleId) ? `rule ${str(route.ruleId)}` : null,
        str(route.profile) ? `profile ${str(route.profile)}` : null,
        str(route.via) ? `via ${str(route.via)}` : null,
        str(route.tier) ? `tier ${str(route.tier)}` : null,
        str(route.taskType) ? `task ${str(route.taskType)}` : null,
        typeof route.honored === "boolean" ? `honored: ${route.honored ? "yes" : "no"}` : null
      ),
      tone: "dim",
    });
  }

  const card = str(route.card);
  if (card) {
    const cardUrl = str(route.cardUrl);
    badges.push({
      key: "card",
      label: `card ${card}`,
      title: "this ask was carded - the work runs on the kanban board, not in this conversation",
      tone: "link",
      ...(cardUrl ? { href: cardUrl } : {}),
    });
  }

  const stoppedReason = str(route.stoppedReason);
  if (route.stoppedByUser === true || stoppedReason) {
    badges.push({
      key: "stopped",
      label: stoppedReason ? `stopped: ${stoppedReason}` : "stopped by you",
      title: stoppedReason
        ? `the turn was cancelled (${stoppedReason}) - the reply above is partial`
        : "you cancelled this turn - the reply above is partial",
      tone: "warn",
    });
  }

  const sessionId = str(route.sessionId);
  if (sessionId) {
    // The routed runtime's session is not a separate place to go looking: it is a
    // drill-down on the bubble it produced. codex/gemini report no session id at
    // all, which is exactly why this badge is gated on one being present.
    const transcriptPath = str(route.transcriptPath);
    badges.push({
      key: "transcript",
      label: "transcript",
      title: title(`open the session transcript for ${sessionId}`, transcriptPath || null),
      action: "transcript",
    });
  }

  const applied = (Array.isArray(route.overridesApplied) ? route.overridesApplied : [])
    .map((f) => str(f))
    .filter(Boolean);
  if (applied.length) {
    badges.push({
      key: "override",
      label: `override: ${applied.join(", ")}`,
      title: `this turn ran with your pinned ${applied.join(", ")} instead of the composition's routing`,
    });
  }

  const rejected = (Array.isArray(route.overridesRejected) ? route.overridesRejected : []).filter(
    (r) => r && (str(r.field) || str(r.reason))
  );
  for (const r of rejected) {
    // One badge per rejection, keyed by field: a pin the gateway refused must say
    // so out loud. Merging them would hide which dimension fell back.
    const field = str(r.field) || "override";
    const reason = str(r.reason) || "rejected";
    badges.push({
      key: `override-rejected:${field}`,
      label: `override rejected: ${reason}`,
      title: `your pinned ${field} was refused (${reason}) - the composition's routing ran instead`,
      tone: "warn",
    });
  }

  return badges;
}
