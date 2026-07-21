function terminal({
  kind,
  source,
  code,
  component = null,
  message = null,
  outcome = null
}) {
  const recoveryFailure = outcome?.recoveryFailure
    ? fromStructuredFailure(outcome.recoveryFailure, "recovery", outcome.fixerNote, null)
    : null;
  // Vision session linkage: a completed step carries it inside result.vision,
  // a failed one at the step-record top level (engine attaches err.visionMeta).
  const vision = outcome?.result?.vision ?? outcome?.vision ?? null;
  return {
    kind,
    source,
    code,
    ...(component ? { component } : {}),
    ...(message ? { message: String(message) } : {}),
    ...(outcome?.tier !== undefined ? { tier: outcome.tier } : {}),
    ...(outcome?.evidencePath ? { evidencePath: outcome.evidencePath } : {}),
    ...(outcome?.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
    ...(outcome?.result?.reasoning ? { reasoning: String(outcome.result.reasoning) } : {}),
    ...(vision?.sessionId
      ? {
          session: {
            id: String(vision.sessionId),
            ...(vision.transcriptPath
              ? { transcriptPath: String(vision.transcriptPath) }
              : {})
          }
        }
      : {}),
    ...(recoveryFailure ? { recoveryFailure } : {})
  };
}

function fromStructuredFailure(failure, source, message, outcome) {
  if (!failure) return null;
  if (failure.class === "product") {
    return terminal({
      kind: "product-failure",
      source,
      code: failure.code || "assertion-failed",
      component: failure.component || "app",
      message,
      outcome
    });
  }
  if (failure.class === "infrastructure") {
    return terminal({
      kind: "infra-failure",
      source,
      code: failure.code || "dependency-failure",
      component: failure.component || "automations",
      message,
      outcome
    });
  }
  return terminal({
    kind: "incomplete",
    source,
    code: failure.code || "unclassified-failure",
    component: failure.component || "automations",
    message,
    outcome
  });
}

export function legacyInfrastructureFailure(message) {
  const text = String(message ?? "").trim();
  let match;
  if (/^automations unavailable(?:\b|:)/i.test(text) || /^automations fitting not running\b/i.test(text)) {
    return { component: "automations", code: "automations-unavailable" };
  }
  if ((match = text.match(/^automations (?:HTTP )?([45]\d\d)(?::.*)?$/i))) {
    return { component: "automations", code: `automations-http-${match[1]}` };
  }
  if ((match = text.match(/^vision (?:HTTP )?([45]\d\d)(?::.*)?$/i))) {
    return { component: "vision", code: `vision-http-${match[1]}` };
  }
  if ((match = text.match(/^fixer (?:HTTP )?([45]\d\d)(?::.*)?$/i))) {
    return { component: "fixer", code: `fixer-http-${match[1]}` };
  }
  if ((match = text.match(/^fixer failed: fixer (?:HTTP )?([45]\d\d)(?::.*)?$/i))) {
    return { component: "fixer", code: `fixer-http-${match[1]}` };
  }
  if ((match = text.match(/^browser ([45]\d\d):/i))) {
    return { component: "browser", code: `browser-http-${match[1]}` };
  }
  if (/^(?:TypeError:\s*)?fetch failed(?:$|:)/i.test(text)) {
    return { component: "automations", code: "transport-fetch-failed" };
  }
  if (/^(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE)(?:\b|:)/i.test(text)) {
    return { component: "automations", code: `transport-${text.split(/[\s:]/)[0].toLowerCase()}` };
  }
  const unavailable = text.match(/^(browser|vision|fixer|gateway|orchestrator) fitting not running(?:\b|:)/i);
  if (unavailable) {
    const component = unavailable[1].toLowerCase();
    return { component, code: `${component}-unavailable` };
  }
  return null;
}

export function terminalFromAutomationRun(run, expectedStepId) {
  const target = [...(run?.steps ?? [])].reverse().find((step) => step.stepId === expectedStepId);
  if (target?.status === "completed") {
    if (target.result?.passed === false) {
      return terminal({
        kind: "product-failure",
        source: "step",
        code: "assertion-failed",
        component: "app",
        message: target.result.reasoning || target.error || `${expectedStepId} failed`,
        outcome: target
      });
    }
    return terminal({
      kind: "passed",
      source: "step",
      code: "completed",
      component: "app",
      outcome: target
    });
  }
  if (target?.status === "failed") {
    const structured = fromStructuredFailure(target.failure, "step", target.error, target);
    if (structured) return structured;
    const infra = legacyInfrastructureFailure(target.error);
    if (infra) {
      return terminal({
        kind: "infra-failure",
        source: "step",
        code: infra.code,
        component: infra.component,
        message: target.error,
        outcome: target
      });
    }
    return terminal({
      kind: "product-failure",
      source: "step",
      code: "assertion-or-interaction-failed",
      component: "app",
      message: target.error || `${expectedStepId} failed`,
      outcome: target
    });
  }

  if (["paused_for_user", "awaiting_consent", "awaiting_connector"].includes(run?.status)) {
    return terminal({
      kind: "blocked",
      source: "run",
      code: run.status,
      component: "automations",
      message: run.error || `run ${run.status.replaceAll("_", " ")}`
    });
  }

  if (run?.status === "failed") {
    const structured = fromStructuredFailure(run.failure, "run", run.error, target);
    if (structured) return structured;
    if (/^fixer aborted:/i.test(String(run.error ?? ""))) {
      return terminal({
        kind: "product-failure",
        source: "run",
        code: "recovery-aborted",
        component: "app",
        message: run.error
      });
    }
    const infra = legacyInfrastructureFailure(run.error);
    if (infra) {
      return terminal({
        kind: "infra-failure",
        source: "run",
        code: infra.code,
        component: infra.component,
        message: run.error
      });
    }
    return terminal({
      kind: "incomplete",
      source: "run",
      code: "unclassified-failure",
      component: "automations",
      message: run.error || "Automation failed without a target-step result"
    });
  }

  return terminal({
    kind: "incomplete",
    source: "run",
    code: "expected-step-missing",
    component: "automations",
    message: `Automation ${run?.status || "ended"} without result for ${expectedStepId}`
  });
}

export function terminalFromTransportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const infra = legacyInfrastructureFailure(message);
  return terminal({
    kind: "infra-failure",
    source: "transport",
    code: infra?.code || "automation-transport",
    component: infra?.component || "automations",
    message
  });
}

export function terminalOpensCircuit(outcome) {
  return outcome?.kind === "infra-failure" || outcome?.kind === "incomplete" || outcome?.kind === "blocked";
}
