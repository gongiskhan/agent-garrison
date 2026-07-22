import { describe, expect, it } from "vitest";
import {
  resolvePageUrl, compileStep, selectSteps, compileStepAutomation,
  hasAuth, resolveAuthUrl, authSuccess, normalizeAuthSteps, compileAuthProbe, compileAuthLogin,
  AUTH_LOGIN_ID, AUTH_PROBE_ID, AUTH_VERIFY_STEP
} from "../fittings/seed/drill/lib/compile.mjs";

// B6/R3 — compile Drill pages to automations engine steps. Pure logic.

const book = (url: string) => ({ app: { name: "f", url }, fullDrill: false, autonomy: "gated", viewports: ["desktop"], globalRules: "", dispatch: "manual", pages: [] });

describe("resolvePageUrl", () => {
  it("resolves a sub-path against a normal http base", () => {
    expect(resolvePageUrl(book("http://localhost:3000"), { path: "/chat" })).toBe("http://localhost:3000/chat");
  });
  it("falls back to the app url itself for an empty path or a data:/about: base", () => {
    expect(resolvePageUrl(book("http://localhost:3000"), { path: "" })).toBe("http://localhost:3000");
    expect(resolvePageUrl(book("data:text/html,<h1>x</h1>"), { path: "/chat" })).toBe("data:text/html,<h1>x</h1>");
  });
});

describe("compileStep", () => {
  const page = { id: "chat", areas: [{ n: 1, id: "chat#1", label: "Composer", anchors: { testId: "chat-composer" }, pct: null }] };
  it("compiles to a verify step; a graduated step's assertion becomes cachedAssertion", () => {
    const step = { id: "s1", area: 1, description: "Composer is visible", assertion: { kind: "visible", testId: "chat-composer" }, tags: ["smoke"] };
    const compiled = compileStep(step as any, page as any);
    expect(compiled).toMatchObject({ id: "s1", type: "verify", description: "Composer is visible", cachedAssertion: { kind: "visible", testId: "chat-composer" }, tags: ["smoke"] });
  });
  it("an ungraduated area-scoped step carries an areaHint, no cachedAssertion", () => {
    const step = { id: "s2", area: 1, description: "Composer looks right", tags: [] };
    const compiled = compileStep(step as any, page as any);
    expect(compiled.cachedAssertion).toBeUndefined();
    expect(compiled.areaHint).toEqual({ testId: "chat-composer" });
  });
  it("a page-level step (area 0) has neither cachedAssertion nor areaHint", () => {
    const step = { id: "p1", area: 0, description: "No console errors", tags: [] };
    const compiled = compileStep(step as any, page as any);
    expect(compiled.cachedAssertion).toBeUndefined();
    expect(compiled.areaHint).toBeUndefined();
  });

  it("blind mode (R12/F8) omits cachedAssertion AND areaHint even for an already-graduated step", () => {
    const step = { id: "s1", area: 1, description: "Composer is visible", assertion: { kind: "visible", testId: "chat-composer" }, tags: [] };
    const compiled = compileStep(step as any, page as any, { blind: true });
    expect(compiled).toEqual({ id: "s1", type: "verify", description: "Composer is visible", tags: [] });
    expect(compiled.cachedAssertion).toBeUndefined();
    expect(compiled.areaHint).toBeUndefined();
  });
});

describe("selectSteps", () => {
  const page = {
    id: "chat", title: "Chat", path: "/chat",
    areas: [{ n: 1, id: "chat#1", label: "Composer", anchors: { testId: "chat-composer" }, pct: null }],
    steps: [
      { id: "s1", area: 1, enabled: true, state: "default", viewports: ["desktop", "mobile"], description: "a", tags: [] },
      { id: "s2", area: 0, enabled: false, state: "default", viewports: ["desktop"], description: "disabled, excluded", tags: [] },
      { id: "s3", area: 0, enabled: true, state: "default", viewports: ["mobile"], description: "mobile only", tags: [] },
      { id: "s4", area: 0, enabled: true, state: "building", viewports: ["desktop"], description: "wrong state, excluded", tags: [] }
    ],
    states: []
  };

  it("filters by enabled + state + viewport", () => {
    expect(selectSteps(page as any, { state: "default", viewport: "desktop" }).map((s: any) => s.id)).toEqual(["s1"]);
    expect(selectSteps(page as any, { state: "default", viewport: "mobile" }).map((s: any) => s.id)).toEqual(["s1", "s3"]);
    expect(selectSteps(page as any, { state: "default" }).map((s: any) => s.id)).toEqual(["s1", "s3"]); // no viewport filter
  });

  it("treats omitted fields as permissive defaults, never a silently dead step", () => {
    // Page YAML is also authored outside the UI (the plan agent, hand
    // edits): a missing enabled/state means enabled + default-state, and a
    // missing OR empty viewports list means every viewport. Only an
    // explicit enabled:false (or a real mismatch) excludes.
    const sparse = {
      id: "p", title: "P", path: "/", areas: [],
      steps: [
        { id: "bare", area: 0, description: "no enabled/state/viewports", tags: [] },
        { id: "emptyvp", area: 0, enabled: true, state: "default", viewports: [], description: "empty viewports", tags: [] },
        { id: "off", area: 0, enabled: false, description: "explicitly disabled", tags: [] }
      ],
      states: []
    };
    expect(selectSteps(sparse as any, { state: "default", viewport: "desktop" }).map((s: any) => s.id)).toEqual(["bare", "emptyvp"]);
    expect(selectSteps(sparse as any, { state: "default", viewport: "mobile" }).map((s: any) => s.id)).toEqual(["bare", "emptyvp"]);
    expect(selectSteps({ id: "p", steps: undefined } as any, { state: "default" })).toEqual([]);
  });
});

describe("compileStepAutomation", () => {
  const page = { id: "chat", title: "Chat", path: "/chat", areas: [] };
  const step = { id: "s1", area: 0, description: "answer visible", assertion: { kind: "visible", testId: "answer" }, tags: [] };

  it("produces a stable id derived from page+step, and prefixes a navigate step", () => {
    const a = compileStepAutomation(book("http://localhost:3000"), page as any, step as any);
    expect(a.id).toBe("drill-chat-s1");
    expect(a.steps[0]).toMatchObject({ type: "navigate", url: "http://localhost:3000/chat" });
    expect(a.steps[1]).toMatchObject({ id: "s1", type: "verify", cachedAssertion: { kind: "visible", testId: "answer" } });
  });
  it("the same page+step always compiles to the SAME automation id (cache persists run to run)", () => {
    const a1 = compileStepAutomation(book("http://localhost:3000"), page as any, step as any);
    const a2 = compileStepAutomation(book("http://localhost:3000"), page as any, step as any);
    expect(a1.id).toBe(a2.id);
  });
});

// A-auth — authenticated runs: log in ONCE before the checks. Pure compile logic.
describe("auth compile helpers", () => {
  const authBook = (auth: any, url = "http://localhost:3000") => ({ ...book(url), auth });
  const flow = {
    loginPath: "/login",
    steps: ["fill the email field with test@x.io", { id: "pw", description: "fill the password field with hunter2" }, "click Sign in"],
    success: "the app sidebar is visible and no login form remains"
  };

  it("hasAuth is true only for a Book with at least one real login action", () => {
    expect(hasAuth(book("http://localhost:3000") as any)).toBe(false); // no auth block
    expect(hasAuth(authBook(null) as any)).toBe(false);
    expect(hasAuth(authBook({ steps: [] }) as any)).toBe(false);
    expect(hasAuth(authBook({ steps: ["", "   "] }) as any)).toBe(false); // blank actions don't count
    expect(hasAuth(authBook(flow) as any)).toBe(true);
  });

  it("resolveAuthUrl resolves loginPath against app.url, or falls back to the app url", () => {
    expect(resolveAuthUrl(authBook(flow) as any)).toBe("http://localhost:3000/login");
    expect(resolveAuthUrl(authBook({ steps: flow.steps }) as any)).toBe("http://localhost:3000"); // no loginPath -> app root
    expect(resolveAuthUrl(authBook({ ...flow, loginPath: "https://auth.example/login" }) as any)).toBe("https://auth.example/login");
  });

  it("normalizeAuthSteps gives stable id-safe ids, dropping blanks; strings and objects both work", () => {
    expect(normalizeAuthSteps(authBook(flow) as any)).toEqual([
      { id: "login-0", description: "fill the email field with test@x.io" },
      { id: "pw", description: "fill the password field with hunter2" },
      { id: "login-2", description: "click Sign in" }
    ]);
    expect(normalizeAuthSteps(authBook({ steps: ["  a  ", "", { description: "" }, "b"] }) as any)).toEqual([
      { id: "login-0", description: "a" },
      { id: "login-1", description: "b" }
    ]);
  });

  it("normalizeAuthSteps never emits colliding ids (duplicate explicit ids, or explicit-vs-generated clashes) are suffixed", () => {
    // Two hand-authored `id: fill` steps would otherwise give the compiled
    // automation two steps with the same id — the engine keys its cache and
    // result addressing off stepId, so a collision crosses their verdicts.
    expect(normalizeAuthSteps(authBook({ steps: [{ id: "fill", description: "a" }, { id: "fill", description: "b" }] }) as any)).toEqual([
      { id: "fill", description: "a" },
      { id: "fill-2", description: "b" }
    ]);
    // An explicit id that collides with a LATER generated login-<i> is suffixed
    // (step 0 claims "login-1"; step 1's generated base is also "login-1").
    expect(normalizeAuthSteps(authBook({ steps: [{ id: "login-1", description: "explicit" }, "second"] }) as any).map((s: any) => s.id))
      .toEqual(["login-1", "login-1-2"]);
  });

  it("authSuccess returns the trimmed signal, or null when absent/blank", () => {
    expect(authSuccess(authBook(flow) as any)).toBe("the app sidebar is visible and no login form remains");
    expect(authSuccess(authBook({ steps: flow.steps }) as any)).toBeNull();
    expect(authSuccess(authBook({ ...flow, success: "   " }) as any)).toBeNull();
  });

  it("compileAuthProbe is navigate + verify(success), or null without a success signal", () => {
    expect(compileAuthProbe(authBook({ steps: flow.steps }) as any)).toBeNull();
    const probe = compileAuthProbe(authBook(flow) as any)!;
    expect(probe.id).toBe(AUTH_PROBE_ID);
    expect(probe.steps).toEqual([
      { id: "__auth_navigate", type: "navigate", url: "http://localhost:3000/login" },
      { id: AUTH_VERIFY_STEP, type: "verify", description: flow.success }
    ]);
  });

  it("compileAuthLogin is navigate + each action + verify(success); the verify is dropped without a success signal", () => {
    const login = compileAuthLogin(authBook(flow) as any);
    expect(login.id).toBe(AUTH_LOGIN_ID);
    expect(login.steps.map((s: any) => [s.id, s.type])).toEqual([
      ["__auth_navigate", "navigate"],
      ["login-0", "browser"],
      ["pw", "browser"],
      ["login-2", "browser"],
      [AUTH_VERIFY_STEP, "verify"]
    ]);
    // No success signal: no verify step, so a completed run is the only pass evidence.
    const noSuccess = compileAuthLogin(authBook({ steps: flow.steps }) as any);
    expect(noSuccess.steps.at(-1)).toMatchObject({ id: "login-2", type: "browser" });
    expect(noSuccess.steps.some((s: any) => s.type === "verify")).toBe(false);
  });

  it("stable auth automation ids: the login flow replays deterministically run to run", () => {
    expect(compileAuthLogin(authBook(flow) as any).id).toBe(compileAuthLogin(authBook(flow) as any).id);
    expect(compileAuthProbe(authBook(flow) as any)!.id).toBe(AUTH_PROBE_ID);
  });
});
