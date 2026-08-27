import type { RouteStamp } from "./api";

// ── the card-front execution badges (runtime · model · effort · account · duty) ──
//
// The board used to fold every routing dimension into ONE "plan @ opus" chip, and
// only after a turn had settled — so while a card was actually running (exactly when
// you want to know what is burning) it showed nothing at all. These render each
// dimension as its own badge, from the SETTLED route when there is one and from the
// card's EXPECTED route (resolved from its duty/level) otherwise.
//
// Honesty rules, matching the board's existing conventions:
//   - a dimension the gateway never reported gets NO badge (never a placeholder),
//   - an expected badge is visually distinct (dashed) and titled "will run on",
//     so it can never be read as a claim about what did run,
//   - `account` is tri-state: absent = unreported (no badge), null = machine login.
export interface ExecBadge {
  key: string;
  label: string;
  value: string;
  title: string;
}

export function execBadges(settled: RouteStamp | null | undefined, expected: RouteStamp | null | undefined): { badges: ExecBadge[]; expected: boolean } {
  const r = settled || expected || null;
  if (!r) return { badges: [], expected: false };
  const isExpected = !settled;
  const when = isExpected ? "will run on" : "ran on";
  const out: ExecBadge[] = [];
  const push = (key: string, label: string, value: unknown, title: string) => {
    const v = typeof value === "number" ? String(value) : String(value ?? "").trim();
    if (!v) return;
    out.push({ key, label, value: v, title });
  };
  push("runtime", "runtime", r.runtime || r.provider, `${when} the ${r.runtime || r.provider} runtime`);
  push("model", "model", r.model, [
    `${when} model ${r.model}`,
    r.targetId ? `target: ${r.targetId}` : "",
    r.tier ? `routed tier: ${r.tier}` : ""
  ].filter(Boolean).join(" · "));
  // Effort carries its own application truth — "medium" and "medium (not applied)"
  // are different facts and must not render identically.
  const effort = (r.effort || "").trim();
  if (effort) {
    const applied = r.effortApplied;
    push(
      "effort",
      "effort",
      applied === false ? `${effort} (not applied)` : effort,
      applied === true
        ? `effort ${effort} — the runtime confirmed it applied this`
        : applied === false
          ? `effort ${effort} — the runtime reported it did NOT apply this`
          : `effort ${effort} — the runtime did not report whether it applied this`
    );
  }
  if (r.duty) {
    push("duty", "duty", Number.isInteger(r.level) ? `${r.duty} L${r.level}` : r.duty, `duty ${r.duty}${Number.isInteger(r.level) ? ` at level ${r.level}` : ""}`);
  }
  // WHERE the turn ran. Only shown once a turn has settled: before that the card's
  // own project chip already says which repo it is FOR, and repeating it as an
  // execution badge would imply we know where it will run.
  if (!isExpected && r.project) {
    push("project", "in", r.project, `the turn ran in the ${r.project} repo`);
  }
  // A REFUSED project is the one thing that must never be silent: the turn then ran
  // in the composition directory, not the card's repo. Surface it loudly.
  const refusedProject = (r.overridesRejected || []).find((x) => x && x.field === "project");
  if (refusedProject) {
    const personalUnavailable = refusedProject.reason === "personal-workspace-unavailable";
    if (personalUnavailable) {
      push(
        "project-refused",
        "scope",
        "refused",
        "The turn was refused because the fixed personal workspace was missing, invalid, or symlinked. Run Kanban setup and verify GARRISON_HOME/personal."
      );
    } else {
      push(
        "project-refused",
        "not in",
        "composition dir",
        `The card's project could not be used as the turn's working directory (${refusedProject.reason}), ` +
          "so the turn ran in the composition directory instead. A project must be a git repo directly under the dev root."
      );
    }
  }
  if ("account" in (r as unknown as Record<string, unknown>) && r.account !== undefined) {
    push("account", "account", r.account ?? "machine login", r.account
      ? `Anthropic account: ${r.account}${r.accountSource ? ` (${r.accountSource})` : ""}`
      : "no named account — the machine's own Claude login");
  }
  return { badges: out, expected: isExpected };
}
