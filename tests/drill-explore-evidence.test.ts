import http, { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compactExploreElements,
  compactExploreNetwork,
  isCoherentExploreQuiet,
  safeExploreBrowserContext,
  safeExploreNetworkUrl,
  safeExplorePageUrl,
  safeExploreQuietMetadata,
  sanitizeExploreConsoleText
} from "../fittings/seed/drill/lib/explore-evidence.mjs";
import {
  assertExplore,
  closeExplore,
  exploreTabFor,
  getExploreObservation,
  hasPassedExploreAssertion,
  listExploreObservations,
  openExplore
} from "../fittings/seed/drill/lib/explore.mjs";

describe("Drill exploration evidence compaction", () => {
  it("classifies page requests while removing URL secrets and background types", () => {
    const since = 10_000;
    const now = 20_000;
    const network = compactExploreNetwork([
      // Before this explicit navigation: excluded even though it is an issue.
      { ts: 9_999, resourceType: "Fetch", method: "GET", url: "https://app.example/old?secret=old", status: 500, duration: 2 },
      { ts: 10_100, resourceType: "Document", method: "GET", url: "https://alice:password@app.example/dashboard?token=page-secret#private", status: 200, duration: 20 },
      { ts: 10_200, resourceType: "Fetch", method: "POST", url: "https://bob:password@api.example/v1/items?apiKey=cross-secret#private", status: 201, duration: 30 },
      { ts: 10_300, resourceType: "XHR", method: "GET", url: "https://app.example/bad?credential=bad-secret", status: 503, duration: 40 },
      // A response may have status 200 and still be pending (SSE/streaming).
      { ts: 10_400, resourceType: "EventSource", method: "GET", url: "https://app.example/events?bearer=stream-secret", status: 200, duration: null, persistent: true },
      { ts: 10_500, resourceType: "WebSocket", method: "GET", url: "wss://socket-user:socket-pass@socket.example/live?auth=socket-secret", failed: true, failureText: "socket-secret" },
      // Deliberately excluded request classes must not leak either.
      { ts: 10_600, resourceType: "Image", method: "GET", url: "https://cdn.example/image.png?secret=image-secret", status: 200, duration: 4 },
      { ts: 10_700, resourceType: "Script", method: "GET", url: "https://cdn.example/app.js?secret=script-secret", status: 200, duration: 5 }
    ], { pageUrl: "https://app.example/dashboard?session=top-secret", since, now });

    expect(network.summary).toMatchObject({
      windowStartedAt: new Date(since).toISOString(),
      total: 5,
      pending: 0,
      persistent: 1,
      non2xx: 1,
      transportFailures: 1,
      completed2xx: 2
    });
    expect(network.issues.pending).toEqual([]);
    expect(network.issues.persistent).toEqual([
      expect.objectContaining({ resourceType: "EventSource", url: "/events", status: 200, pending: true, persistent: true, durationMs: null, ageMs: 9_600 })
    ]);
    expect(network.issues.httpErrors).toEqual([
      expect.objectContaining({ resourceType: "XHR", url: "/bad", status: 503, pending: false, durationMs: 40 })
    ]);
    expect(network.issues.transportFailures).toEqual([
      expect.objectContaining({ resourceType: "WebSocket", url: "wss://socket.example/live", failed: true, pending: false })
    ]);
    expect(network.recent2xx.map((entry: any) => entry.url)).toEqual([
      "https://api.example/v1/items",
      "/dashboard"
    ]);

    const wire = JSON.stringify(network);
    for (const secret of [
      "alice", "password", "page-secret", "top-secret", "bob", "cross-secret",
      "bad-secret", "stream-secret", "socket-user", "socket-pass", "socket-secret",
      "image-secret", "script-secret"
    ]) expect(wire).not.toContain(secret);
  });

  it("globally caps detail rows and prioritises issues over recent successes", () => {
    const entries = [
      { ts: 1, resourceType: "XHR", url: "https://app.test/failing", status: 500, duration: 2 },
      { ts: 2, resourceType: "EventSource", url: "https://app.test/hanging", status: 200, duration: null },
      ...Array.from({ length: 8 }, (_, index) => ({
        ts: 10 + index,
        resourceType: "Fetch",
        url: `https://app.test/ok-${index}?secret=${index}`,
        status: 200,
        duration: 3
      }))
    ];
    const network = compactExploreNetwork(entries, {
      pageUrl: "https://app.test/",
      now: 100,
      limit: 2
    });

    expect(network.truncated).toBe(true);
    expect(network.summary.total).toBe(10);
    expect(network.issues.httpErrors).toHaveLength(1);
    expect(network.issues.pending).toHaveLength(1);
    expect(network.recent2xx).toHaveLength(0);
  });

  it("keeps redirects and 304 facts separate from HTTP errors", () => {
    const network = compactExploreNetwork([
      { ts: 1, resourceType: "Document", url: "https://app.test/start", status: 302, duration: 2 },
      { ts: 2, resourceType: "Fetch", url: "https://app.test/cached", status: 304, duration: 3 },
      { ts: 3, resourceType: "XHR", url: "https://app.test/bad", status: 500, duration: 4 },
      { ts: 4, resourceType: "Document", url: "https://app.test/multiple", status: 300, duration: 5 }
    ], { pageUrl: "https://app.test/final", now: 10 });

    expect(network.summary).toMatchObject({
      non2xx: 4,
      redirects: 1,
      notModified: 1,
      httpErrors: 1,
      otherNon2xx: 1
    });
    expect(network.issues.httpErrors).toEqual([
      expect.objectContaining({ url: "/bad", status: 500 })
    ]);
    expect(network.otherResponses.redirects).toEqual([
      expect.objectContaining({ url: "/start", status: 302 })
    ]);
    expect(network.otherResponses.notModified).toEqual([
      expect.objectContaining({ url: "/cached", status: 304 })
    ]);
    expect(network.otherResponses.otherNon2xx).toEqual([
      expect.objectContaining({ url: "/multiple", status: 300 })
    ]);
  });

  it("keeps static-resource failures and pending requests but drops their successes", () => {
    const network = compactExploreNetwork([
      { ts: 1, resourceType: "Image", url: "https://app.test/token/IMAGE_PATH_SECRET", status: 404, duration: 2 },
      { ts: 2, resourceType: "Script", url: "https://app.test/assets/loading.js", status: 200, duration: null },
      { ts: 3, resourceType: "Font", url: "https://app.test/assets/font.woff2", failed: true },
      { ts: 4, resourceType: "Stylesheet", url: "https://app.test/assets/ok.css", status: 200, duration: 2 },
      { ts: 5, resourceType: "Fetch", url: "https://app.test/api/ok", status: 200, duration: 2 },
      { ts: 6, resourceType: "WebSocket", url: "wss://app.test/live", status: 101, duration: null, persistent: true }
    ], { pageUrl: "https://app.test/", now: 10 });

    expect(network.summary).toMatchObject({
      total: 5,
      pending: 1,
      persistent: 1,
      httpErrors: 1,
      otherNon2xx: 0,
      transportFailures: 1,
      completed2xx: 1
    });
    expect(network.issues.httpErrors).toContainEqual(
      expect.objectContaining({ resourceType: "Image", url: "/token/[redacted]", status: 404 })
    );
    expect(network.issues.pending).toContainEqual(
      expect.objectContaining({ resourceType: "Script", url: "/assets/loading.js" })
    );
    expect(network.issues.transportFailures).toContainEqual(
      expect.objectContaining({ resourceType: "Font", url: "/assets/font.woff2" })
    );
    expect(network.issues.persistent).toContainEqual(
      expect.objectContaining({ resourceType: "WebSocket", url: "wss://app.test/live", status: 101 })
    );
    expect(network.recent2xx).toEqual([
      expect.objectContaining({ resourceType: "Fetch", url: "/api/ok" })
    ]);
    expect(JSON.stringify(network)).not.toContain("IMAGE_PATH_SECRET");
  });

  it("sanitizes page URLs, console secrets, and quiet metadata", () => {
    expect(safeExplorePageUrl("https://alice:password@app.test/callback?code=URL_SECRET#private"))
      .toBe("https://app.test/callback");
    const consoleText = sanitizeExploreConsoleText(
      "failed https://bob:URL_PASSWORD@api.test/v1/items?token=URL_TOKEN#private /local?code=LOCAL_CODE password=BARE_PASSWORD Bearer BEARER_TOKEN"
    );
    expect(consoleText).toContain("https://api.test/v1/items");
    expect(consoleText).toContain("/local");
    for (const secret of ["bob", "URL_PASSWORD", "URL_TOKEN", "LOCAL_CODE", "BARE_PASSWORD", "BEARER_TOKEN"]) {
      expect(consoleText).not.toContain(secret);
    }

    const structured = sanitizeExploreConsoleText(
      '{"authorization":"Bearer MULTI WORD AUTH VALUE","password":"JSON PASSWORD WITH SPACES"} ' +
      "Authorization: Basic HEADER VALUE WITH SPACES; " +
      "failed /reset-password/PATH_RESET_SECRET and /invite/eyJabc123456789.abcdefghi123456.zzzzzzzzz999999"
    );
    expect(structured).toContain('"authorization":"[redacted]"');
    expect(structured).toContain("Authorization:[redacted]");
    expect(structured).toContain("/reset-password/[redacted]");
    expect(structured).toContain("/invite/[redacted]");
    for (const secret of ["MULTI WORD AUTH VALUE", "JSON PASSWORD WITH SPACES", "HEADER VALUE WITH SPACES", "PATH_RESET_SECRET", "eyJabc123456789"]) {
      expect(structured).not.toContain(secret);
    }

    expect(safeExploreQuietMetadata({
      outcome: "quiet",
      waitedMs: 600.4,
      networkQuiet: true,
      domStable: true,
      timedOut: false,
      profilePath: "/secret/profile"
    })).toEqual({
      outcome: "quiet",
      waitedMs: 600,
      networkQuiet: true,
      domStable: true,
      timedOut: false
    });
    expect(isCoherentExploreQuiet({ outcome: "quiet" })).toBe(false);
    expect(isCoherentExploreQuiet({
      outcome: "quiet", networkQuiet: true, domStable: true, timedOut: false
    })).toBe(true);
    expect(isCoherentExploreQuiet({
      outcome: "quiet", networkQuiet: false, domStable: true, timedOut: false
    })).toBe(false);
  });

  it("keeps one honest missing-name cue per interactive role", () => {
    const compacted = compactExploreElements([
      { role: "link", name: "" },
      { role: "link", name: " " },
      { role: "button", name: "" },
      { role: "menuitem", name: "" },
      { role: "tab", name: "" },
      { role: "generic", name: "" },
      { role: "link", name: "Documentation" }
    ]);

    expect(compacted).toEqual({
      elements: [
        { role: "link", accessibleNameMissing: true },
        { role: "button", accessibleNameMissing: true },
        { role: "menuitem", accessibleNameMissing: true },
        { role: "tab", accessibleNameMissing: true },
        { role: "link", name: "Documentation" }
      ],
      truncated: false
    });
    expect(JSON.stringify(compacted)).not.toContain('"name":"Unnamed"');

    const capped = compactExploreElements([
      { role: "link", name: "One" },
      { role: "link", name: "Two" },
      { role: "link", name: "Three" }
    ], { limit: 2 });
    expect(capped.elements).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  it("only forwards documented browser context scalars", () => {
    expect(safeExploreBrowserContext({
      persistentProfile: true,
      tabAgeMs: 12.6,
      navigationAgeMs: -4,
      profilePath: "/secret/profile",
      cookies: ["secret"]
    })).toEqual({ persistentProfile: true, tabAgeMs: 13, navigationAgeMs: 0 });
    expect(safeExploreNetworkUrl("not a URL secret=1", null)).toBe("[invalid-url]");
  });
});

describe("Drill exploration receipts", () => {
  const home = mkdtempSync(path.join(tmpdir(), "garrison-explore-receipts-home-"));
  const root = mkdtempSync(path.join(tmpdir(), "garrison-explore-receipts-root-"));
  const retainedRoot = mkdtempSync(path.join(tmpdir(), "garrison-explore-retained-root-"));
  const raceRoot = mkdtempSync(path.join(tmpdir(), "garrison-explore-race-root-"));
  let browser: Server;
  let automations: Server;
  let browserTabSequence = 0;
  let delayNextDelete = false;
  const consoleSinceValues: string[] = [];
  const networkSinceValues: string[] = [];
  let browserQuiet: Record<string, unknown> = {
    outcome: "quiet",
    waitedMs: 600,
    networkQuiet: true,
    domStable: true,
    timedOut: false
  };
  let browserHistoryTruncated: boolean | null = false;
  let browserStabilityToken = `stability-v1-${"a".repeat(32)}`;
  let mutateStabilityOnNextAssertion = false;
  const previous = {
    home: process.env.GARRISON_HOME,
    browser: process.env.GARRISON_BROWSER_URL,
    automations: process.env.GARRISON_AUTOMATIONS_URL
  };

  async function body(req: http.IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  async function listen(server: Server) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  beforeAll(async () => {
    browser = http.createServer((req, res) => void (async () => {
      const url = new URL(req.url ?? "/", "http://browser.test");
      if (req.method === "POST" && url.pathname === "/tabs") {
        await body(req);
        const tabId = `receipt-tab-${++browserTabSequence}`;
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ tabId }));
        return;
      }
      if (req.method === "GET" && /^\/tabs\/receipt-tab-\d+\/observe$/.test(url.pathname)) {
        const observation: any = {
          url: "https://user:password@app.test/final?code=RECEIPT_URL_SECRET#private",
          title: "Receipt",
          headingText: "Receipt",
          viewport: { w: 1280, h: 800 },
          a11y: [{ role: "heading", name: "Receipt" }],
          quiet: browserQuiet,
          stabilityToken: browserStabilityToken,
          browserContext: { persistentProfile: true, tabAgeMs: 1000, navigationAgeMs: 700 }
        };
        if (url.searchParams.get("screenshot") === "1") {
          observation.screenshotB64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(observation));
        return;
      }
      if (req.method === "GET" && /^\/tabs\/receipt-tab-\d+\/console$/.test(url.pathname)) {
        consoleSinceValues.push(url.searchParams.get("since") ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"entries":[]}');
        return;
      }
      if (req.method === "GET" && /^\/tabs\/receipt-tab-\d+\/network$/.test(url.pathname)) {
        networkSinceValues.push(url.searchParams.get("since") ?? "");
        const response: Record<string, unknown> = {
          entries: [],
          historyDroppedCount: browserHistoryTruncated ? 3 : 0
        };
        if (browserHistoryTruncated !== null) response.historyTruncated = browserHistoryTruncated;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }
      if (req.method === "DELETE" && /^\/tabs\/receipt-tab-\d+$/.test(url.pathname)) {
        if (delayNextDelete) {
          delayNextDelete = false;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(404); res.end();
    })());
    const browserBase = await listen(browser);

    automations = http.createServer((req, res) => void (async () => {
      if (req.method !== "POST" || req.url !== "/api/assert") {
        res.writeHead(404); res.end(); return;
      }
      const input = await body(req);
      if (mutateStabilityOnNextAssertion) {
        mutateStabilityOnNextAssertion = false;
        browserStabilityToken = `stability-v1-${"b".repeat(32)}`;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ passed: true, kind: input.assertion?.kind }));
    })());
    const automationsBase = await listen(automations);

    process.env.GARRISON_HOME = home;
    process.env.GARRISON_BROWSER_URL = browserBase;
    process.env.GARRISON_AUTOMATIONS_URL = automationsBase;
  });

  afterAll(async () => {
    await closeExplore({ root }).catch(() => {});
    await closeExplore({ root: retainedRoot }).catch(() => {});
    await closeExplore({ root: raceRoot }).catch(() => {});
    await Promise.all([browser, automations].map((server) =>
      new Promise<void>((resolve) => server.close(() => resolve()))
    ));
    if (previous.home === undefined) delete process.env.GARRISON_HOME;
    else process.env.GARRISON_HOME = previous.home;
    if (previous.browser === undefined) delete process.env.GARRISON_BROWSER_URL;
    else process.env.GARRISON_BROWSER_URL = previous.browser;
    if (previous.automations === undefined) delete process.env.GARRISON_AUTOMATIONS_URL;
    else process.env.GARRISON_AUTOMATIONS_URL = previous.automations;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(retainedRoot, { recursive: true, force: true });
    rmSync(raceRoot, { recursive: true, force: true });
  });

  it("binds exact passed assertions to defensive, constrained quiet receipts", async () => {
    const startedAt = new Date(Date.now() - 100).toISOString();
    const opened = await openExplore({ root, url: "https://app.test/requested" });
    expect(opened.screenshot).toMatch(/\.jpg$/);

    const assertion = { name: "Save", role: "button", kind: "visible" };
    const verdict = await assertExplore({ root, assertion });
    expect(verdict.passed).toBe(true);
    const receipt = getExploreObservation(root, verdict.observationId);
    expect(receipt).toMatchObject({
      root,
      observationId: verdict.observationId,
      conditions: {
        requestedPath: "/requested",
        finalPath: "/final",
        requestedOrigin: "https://app.test",
        finalOrigin: "https://app.test",
        viewport: { id: "desktop", width: 1280, height: 800 },
        actionsSinceOpen: 0,
        quietOutcome: "quiet",
        source: "assert",
        evidenceWindowStartedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
      },
      assertions: [{ assertion, passed: true, kind: "visible" }]
    });
    expect(hasPassedExploreAssertion(root, { kind: "visible", role: "button", name: "Save" }, {
      since: startedAt,
      path: "/requested?state=default#ignored",
      finalPath: "/final?token=ignored#ignored",
      viewport: "desktop",
      url: "https://app.test/final",
      appUrl: "https://app.test/some/configured/base",
      pristine: true
    })).toBe(true);
    expect(hasPassedExploreAssertion(root, assertion, { origin: "https://evil.test" })).toBe(false);
    expect(hasPassedExploreAssertion(root, assertion, { actionsSinceOpen: 1 })).toBe(false);
    expect(hasPassedExploreAssertion(root, { ...assertion, name: "Delete" })).toBe(false);
    expect(hasPassedExploreAssertion(root, assertion, { path: "/wrong" })).toBe(false);
    expect(receipt.url).toBe("https://app.test/final");
    expect(JSON.stringify(receipt)).not.toContain("RECEIPT_URL_SECRET");
    expect(hasPassedExploreAssertion(root, assertion, { viewport: "mobile" })).toBe(false);
    expect(hasPassedExploreAssertion(root, assertion, {
      since: new Date(Date.now() + 60_000).toISOString()
    })).toBe(false);

    // Returned receipts are copies, not handles into the planner's proof store.
    receipt.assertions[0].passed = false;
    expect(getExploreObservation(root, verdict.observationId)?.assertions[0].passed).toBe(true);
    expect(listExploreObservations(root)).toHaveLength(2);

    browserQuiet = {
      outcome: "quiet", networkQuiet: false, domStable: true, timedOut: false
    };
    const contradictory = { kind: "visible", role: "button", name: "Contradictory" };
    await expect(assertExplore({ root, assertion: contradictory })).rejects.toThrow("page changed while the assertion was evaluated");
    expect(hasPassedExploreAssertion(root, contradictory)).toBe(false);

    browserQuiet = { outcome: "quiet" };
    const partial = { kind: "visible", role: "button", name: "Partial" };
    await expect(assertExplore({ root, assertion: partial })).rejects.toThrow("page changed while the assertion was evaluated");
    expect(hasPassedExploreAssertion(root, partial)).toBe(false);

    browserQuiet = {
      outcome: "quiet", networkQuiet: true, domStable: true, timedOut: false
    };
    browserHistoryTruncated = true;
    const truncated = { kind: "visible", role: "button", name: "Truncated history" };
    expect((await assertExplore({ root, assertion: truncated })).passed).toBe(true);
    expect(hasPassedExploreAssertion(root, truncated)).toBe(false);
    browserHistoryTruncated = false;

    browserHistoryTruncated = null;
    const unknownHistory = { kind: "visible", role: "button", name: "Unknown history" };
    const unknownVerdict = await assertExplore({ root, assertion: unknownHistory });
    expect(unknownVerdict.network.summary).toMatchObject({ historyKnown: false });
    expect(unknownVerdict.network.summary).not.toHaveProperty("historyTruncated");
    expect(hasPassedExploreAssertion(root, unknownHistory)).toBe(false);
    browserHistoryTruncated = false;

    browserQuiet = {
      outcome: "budget-exhausted", networkQuiet: false, domStable: true, timedOut: true
    };
    const boundedOnly = { kind: "visible", role: "button", name: "Bounded only" };
    await expect(assertExplore({ root, assertion: boundedOnly })).rejects.toThrow("page changed while the assertion was evaluated");
    expect(hasPassedExploreAssertion(root, boundedOnly)).toBe(false);

    browserQuiet = { outcome: "unavailable" };
    const unavailable = { kind: "visible", role: "button", name: "Unavailable" };
    await expect(assertExplore({ root, assertion: unavailable })).rejects.toThrow("page changed while the assertion was evaluated");
    expect(hasPassedExploreAssertion(root, unavailable)).toBe(false);

    browserQuiet = {
      outcome: "quiet", networkQuiet: true, domStable: true, timedOut: false
    };
    mutateStabilityOnNextAssertion = true;
    const raced = { kind: "visible", role: "button", name: "Raced" };
    await expect(assertExplore({ root, assertion: raced })).rejects.toThrow("page changed while the assertion was evaluated");
    expect(hasPassedExploreAssertion(root, raced)).toBe(false);

    expect(consoleSinceValues.length).toBeGreaterThan(0);
    expect(consoleSinceValues).toEqual(networkSinceValues);
    expect(consoleSinceValues.every((value) => Number.isFinite(Number(value)) && Number(value) > 0)).toBe(true);
  });

  it("retains assertion receipts and screenshots after agent close, then reopens a fresh tab", async () => {
    browserQuiet = {
      outcome: "quiet", networkQuiet: true, domStable: true, timedOut: false
    };
    browserHistoryTruncated = false;
    const opened = await openExplore({ root: retainedRoot, url: "https://app.test/pristine" });
    const firstTab = opened.tabId;
    expect(opened.actionsSinceOpen).toBe(0);
    expect(existsSync(opened.screenshot)).toBe(true);

    const assertion = { kind: "visible", role: "heading", name: "Receipt" };
    const verdict = await assertExplore({ root: retainedRoot, assertion });
    expect(hasPassedExploreAssertion(retainedRoot, assertion, {
      appUrl: "https://app.test",
      pristine: true
    })).toBe(true);

    const closed = await closeExplore({ root: retainedRoot, retainEvidence: true });
    expect(closed).toMatchObject({ closed: true, retainedEvidence: true, observations: 2 });
    expect(exploreTabFor(retainedRoot)).toBeNull();
    expect(getExploreObservation(retainedRoot, verdict.observationId)).toMatchObject({
      assertions: [{ assertion, passed: true }]
    });
    expect(existsSync(opened.screenshot)).toBe(true);

    const reopened = await openExplore({ root: retainedRoot, url: "https://app.test/continued" });
    expect(reopened.tabId).not.toBe(firstTab);
    expect(reopened.actionsSinceOpen).toBe(0);
    expect(getExploreObservation(retainedRoot, verdict.observationId)?.assertions[0].passed).toBe(true);
    expect(listExploreObservations(retainedRoot)).toHaveLength(3);

    const finalized = await closeExplore({ root: retainedRoot });
    expect(finalized).toMatchObject({ closed: true, retainedEvidence: false });
    expect(getExploreObservation(retainedRoot, verdict.observationId)).toBeNull();
    expect(existsSync(opened.screenshot)).toBe(false);
  });

  it("does not let delayed final cleanup delete an immediately reopened plan session", async () => {
    browserQuiet = {
      outcome: "quiet", networkQuiet: true, domStable: true, timedOut: false
    };
    browserHistoryTruncated = false;
    await openExplore({ root: raceRoot, url: "https://app.test/old-session" });
    delayNextDelete = true;
    const closing = closeExplore({ root: raceRoot });

    const reopened = await openExplore({ root: raceRoot, url: "https://app.test/new-session" });
    await closing;
    expect(exploreTabFor(raceRoot)).toBe(reopened.tabId);
    expect(listExploreObservations(raceRoot)).toHaveLength(1);
    expect(existsSync(reopened.screenshot)).toBe(true);
    await closeExplore({ root: raceRoot });
  });
});
