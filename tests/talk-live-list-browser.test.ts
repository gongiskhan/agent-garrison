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
