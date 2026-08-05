import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// @ts-ignore -- the Drill fitting is intentionally authored as plain ESM.
import { applyPlanIntegrity, capturePlanBaseline, empiricalClaimMarkers, plannerAddedEmpiricalGlobalRules, verificationFingerprint } from "../fittings/seed/drill/lib/plan-integrity.mjs";
// @ts-ignore -- export is from the fitting's plain ESM implementation.
import { inFlightPlanConflict, publicPlanJob } from "../fittings/seed/drill/lib/planner.mjs";
import { deletePage, getDrillBook, getPage, saveDrillBook, savePage } from "../fittings/seed/drill/lib/store.mjs";

const roots: string[] = [];
const STARTED_AT = "2026-08-05T10:00:00.000Z";
const OBSERVED_AT = "2026-08-05T10:00:01.000Z";

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "drill-plan-integrity-"));
  roots.push(root);
  return root;
}

function step(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    area: 0,
    mode: "vision",
    enabled: true,
    viewports: ["desktop"],
    state: "default",
    description: `${id} is usable`,
    tags: [],
    judgment: false,
    ...patch
  };
}

function page(steps: any[], patch: Record<string, unknown> = {}) {
  return {
    id: "dashboard",
    title: "Dashboard",
    path: "/dashboard",
    mode: "steps",
    areas: [],
    steps,
    states: [{ id: "populated", reachPath: ["create a record"] }],
    ...patch
  };
}

async function seed(root: string, steps: any[], options: { globalRules?: string; page?: Record<string, unknown> } = {}) {
  await saveDrillBook({
    app: { name: "Fixture", url: "http://fixture.invalid" },
    viewports: ["desktop"],
    globalRules: options.globalRules ?? "Never display access tokens.",
    pages: [{ id: "dashboard", title: "Dashboard", path: "/dashboard", mode: "steps", selected: true }]
  }, root);
  await savePage("dashboard", page(steps, options.page), root);
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    observationId: "obs-current",
    root: "/private/live-root",
    observedAt: OBSERVED_AT,
    tabId: "tab-secret-coordinate",
    url: "http://fixture.invalid/dashboard",
    screenshot: "/private/live-shot.jpg",
    viewport: { id: "desktop", width: 1440, height: 900 },
    quiet: {
      outcome: "quiet",
      waitedMs: 412,
      quietForMs: 300,
      readyState: "complete",
      networkQuiet: true,
      domStable: true,
      timedOut: false,
      budgetMs: 5000,
      pendingRequests: 0,
      persistentRequests: 1
    },
    browserContext: { persistentProfile: true, tabAgeMs: 812, navigationAgeMs: 500 },
    conditions: {
      source: { kind: "observe" },
      requestedPath: "/dashboard",
      path: "/wrong-fallback-must-not-win",
      finalPath: "/dashboard",
      requestedOrigin: "http://fixture.invalid",
      finalOrigin: "http://fixture.invalid",
      actionsSinceOpen: 0,
      viewport: { id: "desktop", width: 1440, height: 900 },
      quietOutcome: "quiet",
      browserContext: { persistentProfile: true, tabAgeMs: 812, navigationAgeMs: 500 }
    },
    network: {
      summary: {
        total: 7, pending: 0, persistent: 1, non2xx: 2, redirects: 1, notModified: 0,
        httpErrors: 1, otherNon2xx: 0, transportFailures: 0, completed2xx: 5,
        historyKnown: true, historyTruncated: false, historyDroppedCount: 0
      },
      requests: [{ url: "http://secret.invalid/private", authorization: "Bearer secret" }]
    },
    ...overrides
  };
}

function routeReceipt(root: string, route: string, observationId: string) {
  const value: any = receipt({ root, observationId });
  value.url = `http://fixture.invalid${route}`;
  value.conditions.requestedPath = route;
  value.conditions.finalPath = route;
  value.network.summary.historyTruncated = false;
  value.network.summary.historyDroppedCount = 0;
  return value;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("plan verification fingerprints", () => {
  it("invalidates proof for every semantic verification input but not editorial metadata", () => {
    const book = { app: { url: "http://fixture.invalid" }, viewports: ["desktop"] };
    const basePage = page([]);
    const base = step("answer", {
      state: "populated",
      actions: ["open the details panel"],
      assertion: { kind: "visible", role: "heading", name: "Summary" }
    });
    const fingerprint = verificationFingerprint(book, basePage, base);
    const changed = [
      [{ ...book, app: { url: "http://other.invalid" } }, basePage, base],
      [book, { ...basePage, path: "/other" }, base],
      [book, basePage, { ...base, description: "another criterion" }],
      [book, basePage, { ...base, state: "default" }],
      [book, { ...basePage, states: [{ id: "populated", reachPath: ["different setup"] }] }, base],
      [book, basePage, { ...base, actions: ["do something else"] }],
      [book, basePage, { ...base, viewports: ["mobile"] }],
      [book, basePage, { ...base, assertion: { kind: "visible", role: "button", name: "Save" } }]
    ];
    for (const [nextBook, nextPage, nextStep] of changed) {
      expect(verificationFingerprint(nextBook, nextPage, nextStep)).not.toBe(fingerprint);
    }
    expect(verificationFingerprint(book, basePage, { ...base, enabled: false, tags: ["editorial"] })).toBe(fingerprint);
  });

  it("recognises diagnostic/history markers without banning timeless safety criteria", () => {
    const examples = [
      "Standing defect: the page is blank.",
      "The banner says timed out after 5000ms.",
      "Allow each page 30 seconds before checking it.",
      "Allow 2+ minutes per page.",
      "Expected failures: 18/28 pages red.",
      "Expected 25% of checks red.",
      "Expect ~a third of all assertions to be red.",
      "Authenticated data requests never reach the browser.",
      "The loader remains indefinitely."
    ];
    for (const text of examples) expect(empiricalClaimMarkers(text), text).not.toEqual([]);
    expect(empiricalClaimMarkers("The UI must never display passwords or access tokens.")).toEqual([]);
  });
});

describe("post-plan assertion integrity", () => {
  it("preserves unchanged proof, authors exact current proof, and strips unsupported changed assertions", async () => {
    const root = tempRoot();
    const unchangedAssertion = { kind: "visible", role: "heading", name: "Dashboard" };
    const acceptedAssertion = { kind: "visible", role: "button", name: "Create" };
    const rejectedAssertion = { kind: "visible", role: "button", name: "Delete everything" };
    await seed(root, [
      step("unchanged", { mode: "e2e", assertion: unchangedAssertion, assertionSource: "proven", spec: "old.spec.ts" }),
      step("accepted", { mode: "e2e", assertion: acceptedAssertion, assertionSource: "proven", spec: "stale.spec.ts" }),
      step("rejected", { mode: "e2e", assertion: rejectedAssertion, assertionSource: "proven", spec: "stale-too.spec.ts" })
    ]);
    const baseline = await capturePlanBaseline(root);
    const planned = await getPage("dashboard", root);
    planned.steps.find((item: any) => item.id === "accepted").description = "The create action is available";
    planned.steps.find((item: any) => item.id === "rejected").description = "The destructive action is available";
    await savePage("dashboard", { steps: planned.steps }, root);

    const calls: any[] = [];
    const result = await applyPlanIntegrity({
      root,
      baseline,
      startedAt: STARTED_AT,
      evidence: {
        hasPassedAssertion: async (assertion: any, constraints: any) => {
          calls.push({ assertion, constraints });
          return JSON.stringify(assertion) === JSON.stringify(acceptedAssertion);
        }
      }
    });
    const saved = await getPage("dashboard", root);
    const unchanged = saved.steps.find((item: any) => item.id === "unchanged");
    const accepted = saved.steps.find((item: any) => item.id === "accepted");
    const rejected = saved.steps.find((item: any) => item.id === "rejected");

    expect(unchanged).toMatchObject({ assertionSource: "proven", spec: "old.spec.ts", assertion: unchangedAssertion });
    expect(accepted).toMatchObject({ assertionSource: "authored", assertion: acceptedAssertion });
    expect(accepted).not.toHaveProperty("spec");
    expect(rejected).toMatchObject({ mode: "vision" });
    expect(rejected).not.toHaveProperty("assertion");
    expect(rejected).not.toHaveProperty("assertionSource");
    expect(rejected).not.toHaveProperty("spec");
    expect(calls.every((call) =>
      call.constraints.path === "/dashboard"
      && call.constraints.viewport === "desktop"
      && call.constraints.appUrl === "http://fixture.invalid"
      && call.constraints.pristine === true
      && call.constraints.finalPath === "/dashboard"
    )).toBe(true);
    expect(result).toMatchObject({ needsAttention: true, downgradedAssertions: 1 });
  });

  it("keeps stateful and behavioural assertions in vision until action-sequence proof exists", async () => {
    const root = tempRoot();
    await seed(root, []);
    const baseline = await capturePlanBaseline(root);
    const assertion = { kind: "visible", role: "heading", name: "Ready" };
    await savePage("dashboard", {
      steps: [
        step("stateful", { mode: "e2e", state: "populated", assertion }),
        step("behavioural", { mode: "e2e", actions: ["click Create"], assertion })
      ]
    }, root);
    let evidenceCalls = 0;
    const result = await applyPlanIntegrity({
      root,
      baseline,
      startedAt: STARTED_AT,
      evidence: { hasPassedAssertion: async () => { evidenceCalls += 1; return true; } }
    });
    const saved = await getPage("dashboard", root);
    expect(saved.steps.map((item: any) => item.mode)).toEqual(["vision", "vision"]);
    expect(saved.steps.every((item: any) => item.assertion === undefined)).toBe(true);
    expect(evidenceCalls).toBe(0);
    expect(result).toMatchObject({ needsAttention: true, downgradedAssertions: 2 });
  });

  it("clears stale proof metadata when an assertion is removed", async () => {
    const root = tempRoot();
    await seed(root, [step("answer", {
      mode: "e2e",
      assertion: { kind: "visible", role: "heading", name: "Dashboard" },
      assertionSource: "proven",
      spec: "tests/drills/dashboard.spec.ts#answer"
    })]);
    const baseline = await capturePlanBaseline(root);
    const changed = (await getPage("dashboard", root)).steps[0];
    delete changed.assertion;
    await savePage("dashboard", { steps: [changed] }, root);
    const specFile = path.join(root, "tests", "drills", "dashboard.spec.ts");
    mkdirSync(path.dirname(specFile), { recursive: true });
    writeFileSync(specFile, "// stale generated test for answer\n", "utf8");
    const result = await applyPlanIntegrity({ root, baseline, startedAt: STARTED_AT });
    const saved = (await getPage("dashboard", root)).steps[0];
    expect(saved).toMatchObject({ mode: "vision" });
    expect(saved).not.toHaveProperty("assertionSource");
    expect(saved).not.toHaveProperty("spec");
    expect(readFileSync(specFile, "utf8")).not.toContain("answer");
    expect(result).toMatchObject({ needsAttention: true, provenanceRepairs: 1 });
  });
});

describe("empirical authoring provenance", () => {
  it("restores unsupported rewrites, quarantines new claims, and leaves timeless criteria enabled", async () => {
    const root = tempRoot();
    const original = step("existing", { description: "The results region has a loading state" });
    await seed(root, [original]);
    const baseline = await capturePlanBaseline(root);
    await savePage("dashboard", {
      steps: [
        step("existing", { description: "Observed at authoring time: the loader never resolves" }),
        step("new-finding", { description: "Standing defect: this page currently shows a blank panel" }),
        step("safety", { description: "The UI must never display passwords or access tokens" })
      ]
    }, root);

    const result = await applyPlanIntegrity({ root, baseline, startedAt: STARTED_AT });
    const saved = await getPage("dashboard", root);
    expect(saved.steps.find((item: any) => item.id === "existing")).toEqual(original);
    expect(saved.steps.find((item: any) => item.id === "new-finding")).toMatchObject({
      enabled: false,
      planGuard: { status: "quarantined" }
    });
    expect(saved.steps.find((item: any) => item.id === "safety").enabled).toBe(true);
    expect(result).toMatchObject({ needsAttention: true, quarantined: 1, restoredSteps: 1 });
  });

  it("persists a safe durable attestation and strips every live receipt coordinate", async () => {
    const root = tempRoot();
    await seed(root, []);
    const baseline = await capturePlanBaseline(root);
    await savePage("dashboard", {
      steps: [step("observed", {
        description: "The account summary remains legible at desktop width",
        authoringObservation: { kind: "snapshot", receipts: ["obs-current"] }
      })]
    }, root);
    const liveReceipt = receipt({ root });
    const result = await applyPlanIntegrity({
      root,
      baseline,
      startedAt: STARTED_AT,
      evidence: { getObservation: async (id: string) => id === "obs-current" ? liveReceipt : null }
    });
    const saved = await getPage("dashboard", root);
    const observation = saved.steps[0].authoringObservation;
    const serialized = JSON.stringify(observation);

    expect(result.needsAttention).toBe(false);
    expect(observation).toEqual({
      kind: "snapshot",
      observedAt: OBSERVED_AT,
      conditions: [{
        observedAt: OBSERVED_AT,
        requestedPath: "/dashboard",
        finalPath: "/dashboard",
        requestedOrigin: "http://fixture.invalid",
        finalOrigin: "http://fixture.invalid",
        actionsSinceOpen: 0,
        viewport: { id: "desktop", width: 1440, height: 900 },
        quiet: {
          outcome: "quiet",
          waitedMs: 412,
          quietForMs: 300,
          readyState: "complete",
          networkQuiet: true,
          domStable: true,
          timedOut: false,
          budgetMs: 5000,
          pendingRequests: 0,
          persistentRequests: 1
        },
        browserContext: { persistentProfile: true, tabAgeMs: 812, navigationAgeMs: 500 },
        source: "observe",
        networkSummary: {
          total: 7, pending: 0, persistent: 1, non2xx: 2, redirects: 1, notModified: 0,
          httpErrors: 1, otherNon2xx: 0, transportFailures: 0, completed2xx: 5,
          historyDroppedCount: 0, historyKnown: true, historyTruncated: false
        }
      }]
    });
    for (const forbidden of ["receipts", "obs-current", root, "tab-secret-coordinate", "/private/live-shot.jpg", "Bearer secret", "requests"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("rejects an observation when the network history window is unknown or truncated", async () => {
    const root = tempRoot();
    await seed(root, []);
    const baseline = await capturePlanBaseline(root);
    await savePage("dashboard", {
      steps: [step("observed", {
        description: "The account summary remains legible at desktop width",
        authoringObservation: { kind: "snapshot", receipts: ["obs-current"] }
      })]
    }, root);
    const unsafe: any = receipt({ root });
    unsafe.network.summary.historyKnown = false;
    const result = await applyPlanIntegrity({
      root,
      baseline,
      startedAt: STARTED_AT,
      evidence: { getObservation: async () => unsafe }
    });
    expect((await getPage("dashboard", root)).steps[0]).toMatchObject({
      enabled: false,
      planGuard: { status: "quarantined", reason: "observation-receipt-mismatch" }
    });
    expect(result.needsAttention).toBe(true);
  });

  it("rejects observations that requested or landed outside the configured app origin", async () => {
    for (const field of ["requestedOrigin", "finalOrigin"] as const) {
      const root = tempRoot();
      await seed(root, []);
      const baseline = await capturePlanBaseline(root);
      await savePage("dashboard", {
        steps: [step(`cross-origin-${field}`, {
          description: "The account summary remains legible at desktop width",
          authoringObservation: { kind: "snapshot", receipts: ["obs-current"] }
        })]
      }, root);
      const unsafe: any = receipt({ root });
      unsafe.conditions[field] = "http://lookalike.invalid";
      const result = await applyPlanIntegrity({
        root,
        baseline,
        startedAt: STARTED_AT,
        evidence: { getObservation: async () => unsafe }
      });
      expect((await getPage("dashboard", root)).steps[0]).toMatchObject({
        enabled: false,
        planGuard: { status: "quarantined", reason: "observation-receipt-mismatch" }
      });
      expect(result.needsAttention).toBe(true);
    }
  });

  it("rejects same-origin redirect evidence attributed to the requested page", async () => {
    const root = tempRoot();
    await seed(root, []);
    const baseline = await capturePlanBaseline(root);
    await savePage("dashboard", {
      steps: [step("redirected", {
        description: "The account summary remains legible at desktop width",
        authoringObservation: { kind: "snapshot", receipts: ["obs-current"] }
      })]
    }, root);
    const redirected: any = receipt({ root });
    redirected.url = "http://fixture.invalid/login";
    redirected.conditions.finalPath = "/login";
    const result = await applyPlanIntegrity({
      root,
      baseline,
      startedAt: STARTED_AT,
      evidence: { getObservation: async () => redirected }
    });
    expect((await getPage("dashboard", root)).steps[0]).toMatchObject({
      enabled: false,
      planGuard: { status: "quarantined", reason: "observation-receipt-mismatch" }
    });
    expect(result.needsAttention).toBe(true);
  });

  it("rejects an unbounded-time diagnosis even when it cites a current screenshot receipt", async () => {
    const root = tempRoot();
    await seed(root, []);
    const baseline = await capturePlanBaseline(root);
    await savePage("dashboard", {
      steps: [step("forever", {
        description: "The loader remains indefinitely",
        authoringObservation: { kind: "snapshot", receipts: ["obs-current"] }
      })]
    }, root);
    const result = await applyPlanIntegrity({
      root,
      baseline,
      startedAt: STARTED_AT,
      evidence: { getObservation: async () => receipt({ root }) }
    });
    const saved = await getPage("dashboard", root);
    expect(saved.steps[0]).toMatchObject({
      enabled: false,
      planGuard: { status: "quarantined", reason: "observation-time-unbounded" }
    });
    expect(result.needsAttention).toBe(true);
  });

  it("keeps receipted current-defect prose out of executable acceptance criteria", async () => {
    const root = tempRoot();
    await seed(root, []);
    const baseline = await capturePlanBaseline(root);
    await savePage("dashboard", {
      steps: [step("current-claim", {
        description: "Standing defect: this page currently shows a blank panel",
        authoringObservation: { kind: "snapshot", receipts: ["obs-current"] }
      })]
    }, root);
    await applyPlanIntegrity({
      root,
      baseline,
      startedAt: STARTED_AT,
      evidence: { getObservation: async () => receipt({ root }) }
    });
    expect((await getPage("dashboard", root)).steps[0]).toMatchObject({
      enabled: false,
      planGuard: { status: "quarantined", reason: "observation-prose-not-acceptance-criterion" }
    });
  });

  it("rejects interaction provenance until exact ordered actions can be persisted and replayed", async () => {
    const root = tempRoot();
    await seed(root, []);
    const baseline = await capturePlanBaseline(root);
    await savePage("dashboard", {
      steps: [step("interaction", {
        description: "The menu responds to its trigger",
        authoringObservation: { kind: "interaction", receipts: ["obs-current"] }
      })]
    }, root);
    await applyPlanIntegrity({
      root,
      baseline,
      startedAt: STARTED_AT,
      evidence: { getObservation: async () => receipt({ root }) }
    });
    expect((await getPage("dashboard", root)).steps[0]).toMatchObject({
      enabled: false,
      planGuard: { status: "quarantined", reason: "observation-interaction-unsupported" }
    });

    const acceptedRoot = tempRoot();
    await seed(acceptedRoot, []);
    const acceptedBaseline = await capturePlanBaseline(acceptedRoot);
    await savePage("dashboard", {
      steps: [step("interaction", {
        description: "The menu responds to its trigger",
        authoringObservation: { kind: "interaction", receipts: ["obs-current"] }
      })]
    }, acceptedRoot);
    const acted = receipt({ root: acceptedRoot });
    (acted.conditions as any).source = { kind: "act", actionKind: "click" };
    const rejected = await applyPlanIntegrity({
      root: acceptedRoot,
      baseline: acceptedBaseline,
      startedAt: STARTED_AT,
      evidence: { getObservation: async () => acted }
    });
    expect(rejected.needsAttention).toBe(true);
    expect((await getPage("dashboard", acceptedRoot)).steps[0]).toMatchObject({
      enabled: false,
      planGuard: { status: "quarantined", reason: "observation-interaction-unsupported" }
    });
  });

  it("does not resurrect prior proof when rejecting prose under a changed page context", async () => {
    const root = tempRoot();
    await seed(root, [step("existing", {
      mode: "e2e",
      assertion: { kind: "visible", role: "heading", name: "Dashboard" },
      assertionSource: "proven",
      spec: "tests/drills/dashboard.spec.ts#existing"
    })]);
    const baseline = await capturePlanBaseline(root);
    await savePage("dashboard", {
      path: "/moved",
      steps: [step("existing", {
        mode: "e2e",
        assertion: { kind: "visible", role: "heading", name: "Dashboard" },
        assertionSource: "proven",
        spec: "tests/drills/dashboard.spec.ts#existing",
        description: "Standing defect: this page currently shows a blank panel"
      })]
    }, root);
    const result = await applyPlanIntegrity({ root, baseline, startedAt: STARTED_AT });
    const saved = (await getPage("dashboard", root)).steps[0];
    expect(saved).toMatchObject({ mode: "vision", description: "existing is usable" });
    expect(saved).not.toHaveProperty("assertion");
    expect(saved).not.toHaveProperty("assertionSource");
    expect(saved).not.toHaveProperty("spec");
    expect(result).toMatchObject({ needsAttention: true, restoredSteps: 1, downgradedAssertions: 1 });
  });
});

describe("Book-level lifecycle boundaries", () => {
  it("restores planner-added diagnostic global rules but permits deletion-only cleanup", async () => {
    const root = tempRoot();
    await seed(root, [], { globalRules: "Typography is consistent." });
    const cleanBaseline = await capturePlanBaseline(root);
    await saveDrillBook({ globalRules: "Typography is consistent. Standing defect: timed out after 5000ms." }, root);
    const rejected = await applyPlanIntegrity({ root, baseline: cleanBaseline, startedAt: STARTED_AT });
    expect((await getDrillBook(root)).globalRules).toBe("Typography is consistent.");
    expect(rejected.globalRulesRestored).toBe(true);

    await saveDrillBook({ globalRules: "Typography is consistent. Standing defect: the loader is blank." }, root);
    const pollutedBaseline = await capturePlanBaseline(root);
    await saveDrillBook({ globalRules: "Typography is consistent." }, root);
    const cleanup = await applyPlanIntegrity({ root, baseline: pollutedBaseline, startedAt: STARTED_AT });
    expect((await getDrillBook(root)).globalRules).toBe("Typography is consistent.");
    expect(cleanup.globalRulesRestored).toBe(false);
    expect(plannerAddedEmpiricalGlobalRules("Standing defect: blank", "")).toBe(false);
    expect(plannerAddedEmpiricalGlobalRules(
      "Typography is consistent.",
      "Typography is consistent. API requests fail across all pages."
    )).toBe(true);
  });

  it("rejects every planner-authored global rule because generic route receipts cannot prove its prose", async () => {
    const rewrittenRoot = tempRoot();
    const originalSafetyRule = "Do not expose credentials. Typography is consistent.";
    await seed(rewrittenRoot, [], { globalRules: originalSafetyRule });
    const rewrittenBaseline = await capturePlanBaseline(rewrittenRoot);
    // Character-subsequence logic would mistake removal of "not" plus the
    // second clause for cleanup. Only deletion of whole unchanged clauses is
    // exempt from corroboration.
    await saveDrillBook({ globalRules: "Do expose credentials." }, rewrittenRoot);
    const rewritten = await applyPlanIntegrity({
      root: rewrittenRoot,
      baseline: rewrittenBaseline,
      startedAt: STARTED_AT
    });
    expect((await getDrillBook(rewrittenRoot)).globalRules).toBe(originalSafetyRule);
    expect(rewritten).toMatchObject({ needsAttention: true, globalRulesRestored: true });

    const root = tempRoot();
    await seed(root, [], { globalRules: "Typography is consistent." });
    const baseline = await capturePlanBaseline(root);
    const expanded = "Typography is consistent. All pages permanently omit their records.";
    await saveDrillBook({ globalRules: expanded }, root);
    const rejected = await applyPlanIntegrity({
      root,
      baseline,
      startedAt: STARTED_AT,
      evidence: {
        listObservations: async () => [
          routeReceipt(root, "/dashboard", "obs-dashboard"),
          routeReceipt(root, "/settings", "obs-settings")
        ]
      }
    });
    expect((await getDrillBook(root)).globalRules).toBe("Typography is consistent.");
    expect(rejected).toMatchObject({
      needsAttention: true,
      globalRulesRestored: true,
      globalRulesEvidenceRoutes: 0
    });
  });

  it("restores established auth/target rewrites and gates new Book-level contracts for review", async () => {
    const establishedRoot = tempRoot();
    await seed(establishedRoot, []);
    const establishedAuth = {
      loginPath: "/login",
      steps: ["fill the demo username", "fill the demo password", "submit the login form"],
      success: "the application navigation is visible"
    };
    await saveDrillBook({ auth: establishedAuth }, establishedRoot);
    const establishedBaseline = await capturePlanBaseline(establishedRoot);
    await saveDrillBook({
      app: { name: "Fixture", url: "http://lookalike.invalid" },
      auth: { loginPath: "/forced-reset", steps: ["change account state"], success: "a spinner appears" }
    }, establishedRoot);
    const repaired = await applyPlanIntegrity({
      root: establishedRoot,
      baseline: establishedBaseline,
      startedAt: STARTED_AT
    });
    expect(await getDrillBook(establishedRoot)).toMatchObject({
      app: { url: "http://fixture.invalid" },
      auth: establishedAuth
    });
    expect(repaired).toMatchObject({
      needsAttention: true,
      bookConfigRepairs: 2,
      bookConfigReviews: 0
    });

    const freshRoot = tempRoot();
    await seed(freshRoot, []);
    await saveDrillBook({ app: { name: "Fixture", url: "" }, auth: null }, freshRoot);
    const freshBaseline = await capturePlanBaseline(freshRoot);
    const newAuth = {
      loginPath: "/login",
      steps: ["fill the test account", "submit the login form"],
      success: "the dashboard heading is visible"
    };
    await saveDrillBook({
      app: { name: "Fixture", url: "http://fixture.invalid" },
      auth: newAuth
    }, freshRoot);
    const review = await applyPlanIntegrity({ root: freshRoot, baseline: freshBaseline, startedAt: STARTED_AT });
    expect(await getDrillBook(freshRoot)).toMatchObject({
      app: { url: "http://fixture.invalid" },
      auth: newAuth
    });
    expect(review).toMatchObject({
      needsAttention: true,
      bookConfigRepairs: 0,
      bookConfigReviews: 2
    });
  });

  it("restores forged proof metadata and an unchanged quarantine guard", async () => {
    const root = tempRoot();
    await seed(root, [
      step("proof", {
        mode: "e2e",
        assertion: { kind: "visible", role: "heading", name: "Dashboard" },
        assertionSource: "proven",
        spec: "tests/drills/dashboard.spec.ts#proof"
      }),
      step("quarantined", {
        enabled: false,
        planGuard: { status: "quarantined", reason: "observation-evidence-missing" }
      }),
      step("observation")
    ]);
    const baseline = await capturePlanBaseline(root);
    const changed = await getPage("dashboard", root);
    delete changed.steps[0].assertionSource;
    changed.steps[0].spec = "forged.spec.ts";
    changed.steps[1].enabled = true;
    delete changed.steps[1].planGuard;
    changed.steps[2].authoringObservation = { kind: "snapshot", receipts: ["forged"] };
    await savePage("dashboard", { steps: changed.steps }, root);

    const result = await applyPlanIntegrity({ root, baseline, startedAt: STARTED_AT });
    const saved = await getPage("dashboard", root);
    expect(saved.steps[0]).toMatchObject({
      assertionSource: "proven",
      spec: "tests/drills/dashboard.spec.ts#proof"
    });
    expect(saved.steps[1]).toMatchObject({
      enabled: false,
      planGuard: { status: "quarantined", reason: "observation-evidence-missing" }
    });
    expect(saved.steps[2]).not.toHaveProperty("authoringObservation");
    expect(result.needsAttention).toBe(true);
    expect(result.provenanceRepairs).toBeGreaterThanOrEqual(3);
  });

  it("flags removed pages, removed steps, and deselected coverage before autonomous running", async () => {
    const root = tempRoot();
    await seed(root, [step("kept"), step("removed")]);
    await savePage("second", page([step("other")], { id: "second", title: "Second", path: "/second" }), root);
    await saveDrillBook({
      pages: [
        { id: "dashboard", title: "Dashboard", path: "/dashboard", mode: "steps", selected: true },
        { id: "second", title: "Second", path: "/second", mode: "steps", selected: true }
      ]
    }, root);
    const baseline = await capturePlanBaseline(root);
    await savePage("dashboard", { steps: [step("kept")] }, root);
    await deletePage("second", root);
    await saveDrillBook({
      pages: [{ id: "dashboard", title: "Dashboard", path: "/dashboard", mode: "steps", selected: false }]
    }, root);

    const result = await applyPlanIntegrity({ root, baseline, startedAt: STARTED_AT });
    expect(result).toMatchObject({ needsAttention: true });
    expect(result.removedCoverage).toBeGreaterThanOrEqual(3);
    expect(result.warnings.join("\n")).toMatch(/removed the pre-plan page file/);
    expect(result.warnings.join("\n")).toMatch(/removed the pre-plan step/);
    expect(result.warnings.join("\n")).toMatch(/deselected or removed/);
  });

  it("never exposes the parsed pre-plan baseline through public job status", () => {
    const publicJob = publicPlanJob({
      root: "/repo",
      status: "planning",
      proc: { pid: 123 },
      snapshot: new Map([["secret", "mtime"]]),
      baseline: { book: { auth: { steps: ["fill password secret"] } }, pages: { private: {} } }
    });
    expect(publicJob).toEqual({ root: "/repo", status: "planning" });
  });

  it("rejects a different direct caller brief instead of silently sharing an in-flight plan", () => {
    const existing = { status: "planning", brief: "Fix the billing dialog" };
    expect(inFlightPlanConflict(existing, "Fix the billing dialog")).toBe(false);
    expect(inFlightPlanConflict(existing, "Fix the account menu")).toBe(true);
    expect(inFlightPlanConflict(existing, null)).toBe(false);
  });
});
