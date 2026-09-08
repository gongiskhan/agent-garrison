import path from "node:path";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, webkit, type Browser } from "playwright";

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

it.each(["chromium", "webkit"])("makes recent native sessions directly visible on a phone in %s without opening the CSG spawner", async engine => {
  const phoneBrowser = engine === "webkit" ? await webkit.launch({ headless: true }) : browser;
  const context = await phoneBrowser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    const requests: string[] = [];
    let releaseInitial: (() => void) | undefined;
    let initialFinished = false;
    const now = new Date().toISOString();
    const threads = Array.from({ length: 80 }, (_, i) => ({ id: `conversation-${i}`, conversationId: `conversation-${i}`, title: `Conversation ${i}`, source: "chat", messages: [], messageCount: 0 }));
    const rows = [["pro", "claude"], ["mini", "claude"], ["mini", "cursor"], ["csg", "cursor"]].map(([node, runtime]) => ({
      id: `${node}-${runtime}`, node, runtime, kind: runtime === "cursor" ? "desktop" : "cli", title: `${node} ${runtime}`,
      status: "working", statusSource: "hooks", nodeStatus: "active", startedAt: now, lastActivityAt: now,
      resumable: false, attachable: false, transcript: { format: "claude-jsonl", path: "/fixture/output.jsonl" },
    }));
    await page.route("http://talk.test/**", async route => {
      const url = new URL(route.request().url());
      requests.push(`${route.request().method()} ${url.pathname}${url.search}`);
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div class="talk-host" style="height:100dvh"><div id="root" style="height:100%"></div></div>' });
      if (url.pathname === '/api/threads/conversation-0' && !initialFinished) {
        await new Promise<void>(resolve => { releaseInitial = resolve; });
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ thread: threads[0] }) });
        initialFinished = true;
        return;
      }
      if (url.pathname.endsWith("/stream")) return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "init", available: true, events: [{ id: "native-output", role: "assistant", blocks: [{ type: "text", text: "Native session output" }] }] })}\n\ndata: {"type":"end"}\n\n` });
      const data = url.pathname === "/api/threads" ? { threads }
        : url.pathname.startsWith("/api/threads/") ? { thread: threads[0] }
        : url.pathname === "/api/zeca" ? { conversationId: threads[0].id }
        : url.pathname === "/api/sidebar" ? { groups: [], archived: [], membership: {}, order: {}, read: {} }
        : url.pathname === "/api/remote-shell/transports" ? { transports: [{ name: "csg", label: "CSG work" }, { name: "local", label: "Pro" }] }
        : url.pathname === "/api/sessions" ? { self: { node: "pro", accentColor: null }, nodes: [], rows }
        : { nodes: [], hits: [] };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto("http://talk.test/");
    await page.evaluate(() => localStorage.setItem("wc.sessions.collapsed.v2", "1"));
    await page.addStyleTag({ content: ["body{margin:0}", "packages/claude-chat/src/claude-chat.css", "packages/talk/ui/styles.css", "node_modules/@xterm/xterm/css/xterm.css"].map(value => value.endsWith(".css") ? readFileSync(path.resolve(value), "utf8") : value).join("\n") });
    await page.addScriptTag({ content: bundle });
    await page.getByRole("button", { name: "Show conversations", exact: true }).click();
    const switcher = page.getByTestId("rail-filter-shells");
    await expect.poll(() => switcher.textContent()).toContain("4");
    const bounds = await switcher.boundingBox();
    expect(bounds!.y).toBeLessThan(200);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    await page.getByRole("button", { name: "Show shell sessions", exact: true }).click();
    expect(await switcher.getAttribute("aria-pressed")).toBe("true");
    expect(await page.getByRole("dialog", { name: "Interactive shells", exact: true }).count()).toBe(0);
    expect(requests.some(url => url.includes("/api/remote-shell/projects"))).toBe(false);
    await page.getByRole("combobox", { name: "Session machine" }).selectOption("mini");
    await page.getByRole("combobox", { name: "Session app" }).selectOption("cursor");
    expect((await page.getByRole("combobox", { name: "Session machine" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await page.getByRole("combobox", { name: "Session app" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect.poll(() => Boolean(releaseInitial)).toBe(true);
    if (engine === 'chromium') {
      releaseInitial!();
      await expect.poll(() => initialFinished).toBe(true);
      await expect.poll(() => page.locator('.wc-main .cc-conversation').count()).toBe(1);
      expect(await page.locator('.wc-shell').evaluate(el => el.classList.contains('wc-shell--open'))).toBe(true);
    }
    const row = page.locator('[data-key="session:mini:mini-cursor"]');
    await expect.poll(() => page.locator('[data-key^="session:"]').count()).toBe(1);
    const box = await row.boundingBox();
    expect(box!.y).toBeGreaterThan(0);
    expect(box!.y + box!.height).toBeLessThan(852);
    expect(await row.locator(".wc-thread-spinner").count()).toBe(1);
    // The older project browser is still available as a creation action,
    // but a CSG-first transport array must not make it contact CSG on open.
    await page.getByTestId("rail-new").click();
    await page.getByRole("button", { name: "Browse project folders…", exact: true }).click();
    const projectPicker = page.getByRole("dialog", { name: "Interactive shells", exact: true });
    await projectPicker.waitFor();
    expect(await projectPicker.getByRole("combobox").inputValue()).toBe("local");
    await expect.poll(() => requests.some(url => url === "GET /api/remote-shell/projects?transport=local")).toBe(true);
    expect(requests.some(url => url.includes("/api/remote-shell/projects?transport=csg"))).toBe(false);
    await projectPicker.getByRole("button", { name: "Close", exact: true }).click();
    await row.getByRole("button").click();
    await page.getByTestId("native-shell-view").waitFor();
    if (engine === 'webkit') {
      releaseInitial!();
      await expect.poll(() => initialFinished).toBe(true);
      expect(await page.getByTestId('sess-view').count()).toBe(1);
    }
    await expect.poll(() => page.locator(".wc-native-terminal-state").textContent()).toContain("Session output");
    await expect.poll(() => page.locator(".xterm-rows").textContent()).toContain("Native session output");
    expect(requests.some(url => url === "POST /api/remote-shell/sessions")).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(await page.locator(".wc-main .cc-composer").count()).toBe(0);
  } finally { await context.close(); if (engine === "webkit") await phoneBrowser.close(); }
}, 45_000);

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
