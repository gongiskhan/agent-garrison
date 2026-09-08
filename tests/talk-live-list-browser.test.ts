import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const output = await build({
    stdin: {
      resolveDir: path.resolve(__dirname, ".."), sourcefile: "talk-list-fixture.tsx", loader: "tsx",
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {TalkApp} from './packages/talk/ui/app';
        createRoot(document.getElementById('root')).render(<TalkApp/>);`,
    }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
  });
  bundle = output.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); });

it("keeps the complete native list through failed refreshes, expires old activity, and accepts successful empty results", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    const now = Date.now();
    const rows = ["pro", "dev", "mini", "csg", "air"].flatMap(node => ["claude", "codex", "cursor"].map(runtime => ({
      id: `${node}-${runtime}`, node, runtime, kind: "desktop", title: `${node} ${runtime}`,
      status: "working", statusSource: "hooks", nodeStatus: "active",
      startedAt: new Date(now).toISOString(), lastActivityAt: new Date(now).toISOString(),
      resumable: false, attachable: false,
    })));
    rows[0].lastActivityAt = new Date(now - 5 * 86_400_000 + 25_000).toISOString();
    let mode = "healthy";
    let reads = 0;
    let completed = 0;
    let release: (() => void) | undefined;
    await page.route("http://talk.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
      if (url.pathname.endsWith("/stream")) return route.fulfill({ contentType: "text/event-stream", body: 'event: snapshot\ndata: {"events":[]}\n\n' });
      let data: unknown = { nodes: [], hits: [] };
      if (url.pathname === "/api/threads") data = { threads: [] };
      if (url.pathname === "/api/sidebar") data = { groups: [], archived: [], membership: {}, order: {}, read: {} };
      if (url.pathname === "/api/sessions") {
        reads++;
        const currentMode = mode;
        if (currentMode === "slow") await new Promise<void>(resolve => { release = resolve; });
        data = currentMode === "malformed" ? { error: "missing index" }
          : { self: { node: "pro", accentColor: null }, nodes: [], rows: currentMode === "empty" ? [] : rows };
        await route.fulfill({ status: currentMode === "failed" ? 503 : 200, contentType: "application/json", body: JSON.stringify(data) });
        completed++;
        return;
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto("http://talk.test/");
    await page.clock.install({ time: new Date(now) });
    await page.addScriptTag({ content: bundle });
    const nativeRows = page.locator('[data-key^="session:"]');
    await expect.poll(() => nativeRows.count()).toBe(15);
    expect((await nativeRows.evaluateAll(elements => elements.map(el => el.getAttribute("data-key")))).sort())
      .toEqual(rows.map(row => `session:${row.node}:${row.id}`).sort());
    for (const failure of ["failed", "malformed"]) {
      mode = failure;
      const before = completed;
      await page.clock.fastForward(5_000);
      await expect.poll(() => completed).toBeGreaterThan(before);
      await expect.poll(() => nativeRows.locator(".wc-thread-spinner").count()).toBe(0);
      expect(await nativeRows.count()).toBe(15);
    }
    mode = "healthy";
    await page.clock.fastForward(5_000);
    await expect.poll(() => nativeRows.locator(".wc-thread-spinner").count()).toBe(15);

    mode = "slow";
    await page.clock.fastForward(5_000);
    await expect.poll(() => Boolean(release)).toBe(true);
    const beforeOverlap = reads;
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("focus")); });
    await page.clock.fastForward(5_000);
    expect(reads).toBe(beforeOverlap);
    release!();
    await expect.poll(() => completed).toBe(reads);

    mode = "failed";
    await page.clock.fastForward(5_000);
    await expect.poll(() => nativeRows.count()).toBe(14);
    expect(await page.locator('[data-key="session:pro:pro-claude"]').count()).toBe(0);
    mode = "empty";
    await page.clock.fastForward(5_000);
    await expect.poll(() => nativeRows.count()).toBe(0);
  } finally { await context.close(); }
}, 30_000);

it("repeated native-session polls retain one Cursor row and clear its spinner despite a peer hook alias", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    const now = new Date().toISOString();
    const native = {
      id: "cursor-session", node: "mini", nodeAccent: null, nodeStatus: "online", shellOrigin: null,
      runtime: "cursor", kind: "desktop", cwd: null, project: null, title: "Workspace review",
      status: "working", statusSource: "hooks", startedAt: now, lastActivityAt: now,
      resumable: false, attachable: false, resumeRef: "cursor-session", resumeCommand: null,
      transcript: { format: "cursor-agent-text", path: "/fixture/cursor-session.txt" }
    };
    let idle = false;
    let reads = 0;
    await page.route("http://talk.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
      if (url.pathname.endsWith("/stream")) return route.fulfill({ contentType: "text/event-stream", body: 'event: snapshot\ndata: {"events":[]}\n\n' });
      let data: unknown = { nodes: [], hits: [] };
      if (url.pathname === "/api/threads") data = { threads: [] };
      if (url.pathname === "/api/sidebar") data = { groups: [], archived: [], membership: {}, order: {}, read: {} };
      if (url.pathname === "/api/sessions") {
        reads++;
        const observed = { ...native, status: idle ? "idle" : "working" };
        const alias = { ...native, runtime: "claude", kind: "cli", transcript: null, status: "working" };
        data = { self: { node: "pro", accentColor: null }, nodes: [], rows: reads % 2 ? [alias, observed] : [observed, alias] };
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto("http://talk.test/");
    await page.clock.install();
    await page.addScriptTag({ content: bundle });
    const row = page.locator('[data-key="session:mini:cursor-session"]');
    await expect.poll(() => row.count()).toBe(1);
    expect(await row.locator(".wc-thread-spinner").count()).toBe(1);
    expect(await row.locator(".wc-thread-rt").textContent()).toBe("CURSOR");
    for (let poll = 0; poll < 6; poll++) {
      idle = poll >= 2;
      const before = reads;
      await page.clock.fastForward(5_000);
      await expect.poll(() => reads).toBeGreaterThan(before);
      await expect.poll(() => row.locator(".wc-thread-spinner").count()).toBe(idle ? 0 : 1);
      expect(await row.count()).toBe(1);
      expect(await row.locator(".wc-thread-rt").textContent()).toBe("CURSOR");
    }
  } finally { await context.close(); }
}, 30_000);

it("discovers another client's conversation without replacing the draft, and retains history through a failed refresh", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    const thread = { id: "qa-standing", conversationId: "qa-standing", title: "Standing QA", source: "chat", messages: [], messageCount: 0 };
    let threads = [thread];
    let failList = false;
    let reads = 0;
    await page.route("http://talk.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
      if (url.pathname === "/api/threads") {
        reads++;
        return route.fulfill({ status: failList ? 503 : 200, contentType: "application/json", body: JSON.stringify(failList ? { error: "temporarily unavailable" } : { threads }) });
      }
      if (url.pathname.endsWith("/stream")) return route.fulfill({ contentType: "text/event-stream", body: 'event: snapshot\ndata: {"events":[]}\n\n' });
      const data = url.pathname === "/api/zeca" ? { conversationId: thread.id }
        : url.pathname === `/api/threads/${thread.id}` ? { thread }
        : url.pathname === "/api/sidebar" ? { groups: [], archived: [], membership: {}, order: {}, read: {} }
        : url.pathname === "/api/sessions" ? { self: { node: "dev-madrid", accentColor: null }, nodes: [], rows: [] }
        : { nodes: [], hits: [] };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto("http://talk.test/");
    await page.clock.install();
    await page.addScriptTag({ content: bundle });
    const input = page.getByRole("textbox", { name: "Message Standing QA" });
    await input.waitFor();
    await input.fill("Keep this unsent draft");
    const originalComposer = await input.elementHandle();
    threads = [thread, { ...thread, id: "qa-from-peer", conversationId: "qa-from-peer", title: "Created by another agent" }];
    await page.clock.fastForward(10_000);
    await expect.poll(() => page.getByRole("button", { name: /^Created by another agent/ }).count()).toBe(1);
    expect(await input.inputValue()).toBe("Keep this unsent draft");
    expect(await originalComposer!.evaluate(el => el.isConnected)).toBe(true);

    failList = true;
    const beforeFailure = reads;
    await page.clock.fastForward(10_000);
    await expect.poll(() => reads).toBeGreaterThan(beforeFailure);
    expect(await page.getByRole("button", { name: /^Created by another agent/ }).count()).toBe(1);
    expect(await input.inputValue()).toBe("Keep this unsent draft");
    expect(await originalComposer!.evaluate(el => el.isConnected)).toBe(true);
  } finally { await context.close(); }
}, 30_000);
