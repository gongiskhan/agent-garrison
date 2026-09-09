import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

// ConversationView in a real browser (this repo has no jsdom and no
// @testing-library; the established convention for a component whose behaviour is
// effects + DOM is an esbuild bundle driven through Playwright, exactly as
// tests/claude-chat-session-events-browser.test.ts does).
//
// What is pinned here is the seam, not the styling: the stream is the body (no
// bubble pane, no Chat/Transcript toggle), search debounces into ONE request,
// a hit re-derives the stream URL with ?from=, a ledger payload reference opens
// the shared modal, and a focus lands with a flash.

const REPO = path.resolve(__dirname, "..");
const css = readFileSync(path.join(REPO, "packages/claude-chat/src/claude-chat.css"), "utf8");
const talkSkin = readFileSync(path.join(REPO, "packages/talk/ui/styles.css"), "utf8");
const kanbanSkin = readFileSync(path.join(REPO, "fittings/seed/kanban-loop/ui/styles.css"), "utf8");
let browser: Browser;
let context: BrowserContext;
let page: Page;
let bundle = "";

beforeAll(async () => {
  const built = await build({
    stdin: {
      sourcefile: "conversation-view-entry.tsx",
      resolveDir: REPO,
      contents: `
        import * as React from "react";
        import { createRoot } from "react-dom/client";
        import { ConversationView } from "./packages/claude-chat/src/ConversationView";
        import { ConversationQuestion } from "./packages/claude-chat/src/ConversationQuestion";
        import { AttentionReply } from "./fittings/seed/kanban-loop/ui/attention-reply";

        class FixtureEventSource {
          constructor(url) {
            this.url = url;
            this.onmessage = null;
            this.onerror = null;
            this.closed = false;
            window.__sources.push(this);
            window.__source = this;
          }
          close() { this.closed = true; }
        }
        window.__sources = [];
        window.EventSource = FixtureEventSource;

        window.__fetches = [];
        window.__searchResponse = { hits: [], truncated: false };
        window.__payloadBody = "{}";
        const json = (value) => new Response(JSON.stringify(value), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
        window.__question = null;
        window.__answerStatus = 202;
        window.__answers = [];
        window.fetch = (input, init) => {
          const url = typeof input === "string" ? input : String(input && input.url ? input.url : input);
          window.__fetches.push(url);
          if (url.endsWith("/question")) return Promise.resolve(json({ question: window.__question }));
          if (url.endsWith("/message")) {
            window.__answers.push(JSON.parse(init.body));
            return Promise.resolve(new Response(JSON.stringify({ accepted: window.__answerStatus === 202, error: "Fixture responder is unavailable" }), { status: window.__answerStatus }));
          }
          if (url.indexOf("/host-map") === 0) return Promise.resolve(json({ map: {} }));
          if (url.indexOf("/search?") !== -1) return Promise.resolve(json(window.__searchResponse));
          if (url.indexOf("/payload/") !== -1) {
            return Promise.resolve(new Response(window.__payloadBody, { status: 200 }));
          }
          return Promise.resolve(json({}));
        };

        window.__sends = [];
        const transport = {
          base: "",
          connect(onEvent) { onEvent({ type: "connection", state: "open" }); return () => {}; },
          async uploadFile() { return { path: "/tmp/layout-fixture" }; },
          async sendMessage(text, meta) { window.__sends.push({ text, meta }); },
          async sendKey() {},
          async setMode(mode) { return { mode, reached: true }; },
          async interrupt() {},
          async fetchCommands() { return []; },
        };
        const lifecycleTransport = {
          ...transport,
          inputLifecycle: true,
          async sendMessage(text, meta) {
            window.__sends.push({ text, meta });
            return {
              clientRequestId: meta.clientRequestId,
              inputId: "input-" + window.__sends.length,
              state: "queued",
              position: 2,
              acceptedAt: "2026-08-26T12:00:00Z",
            };
          },
        };

        const raf2 = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        let root;
        window.__mount = (props = {}) => {
          if (!root) root = createRoot(document.getElementById("root"));
          const { lifecycle, ...rest } = props;
          root.render(React.createElement(ConversationView, {
            conversationId: "01CONV",
            title: "Ship the ladder",
            transport: lifecycle ? lifecycleTransport : transport,
            ...rest,
          }));
          return raf2();
        };
        window.__mountRecord = () => {
          if (!root) root = createRoot(document.getElementById("root"));
          root.render(React.createElement(AttentionReply, { card: { id: "01CONV", rev: 3, conversationId: null }, onAnswered: () => {} }));
          return raf2();
        };
        window.__mountQuestion = (compact = false) => {
          if (!root) root = createRoot(document.getElementById("root"));
          root.render(React.createElement(ConversationQuestion, { conversationId: "01CONV", compact, origin: "kanban" }));
          return raf2();
        };
        window.__emit = (payload) => {
          window.__source.onmessage({ data: JSON.stringify(payload) });
          return raf2();
        };
        window.__streamUrls = () => window.__sources.map((source) => source.url);
        window.__searchCalls = () => window.__fetches.filter((url) => url.indexOf("/search?") !== -1);
      `,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  bundle = built.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  page = await context.newPage();
}, 60_000);

beforeEach(async () => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.setContent(
    `<style>html,body{margin:0;height:100%}#root{height:100%}` +
    `${css.replace(/<\/style/gi, "<\\/style")}</style><div id="root"></div>`
  );
  await page.addScriptTag({ content: bundle });
});

describe("conversation composer space", () => {
  it.each([
    { name: "talk-desktop", width: 1100, height: 760, paneHeight: 760, host: "talk-host", skin: talkSkin },
    { name: "talk-phone", width: 390, height: 720, paneHeight: 720, host: "talk-host", skin: talkSkin },
    { name: "kanban-card", width: 700, height: 760, paneHeight: 420, host: "kanban-conversation", skin: kanbanSkin },
  ])("keeps controls compact and messages readable in $name", async ({ name, width, height, paneHeight, host, skin }) => {
    await page.setViewportSize({ width, height });
    await page.addStyleTag({ content: skin });
    await page.evaluate(({ host, paneHeight }) => {
      const root = document.getElementById("root")!;
      root.className = host;
      root.style.height = `${paneHeight}px`;
      root.style.minHeight = "0";
    }, { host, paneHeight });
    await mount();
    await emit({ type: "init", available: true, live: false, events: [
      { id: "01CONV#1", role: "user", ts: 1, revision: 1, blocks: [{ type: "text", text: "Please review the latest changes and explain what is ready." }] },
      { id: "01CONV#2", role: "assistant", ts: 2, revision: 1, blocks: [{ type: "text", text: "The review is complete. The conversation keeps its reading space while the message field grows with your draft.\n\nAttachments and routing remain within reach beneath the message box." }] },
    ] });
    const attach = page.getByRole("button", { name: "Attach a file", exact: true });
    const attachmentBox = await attach.boundingBox();
    expect(attachmentBox?.width).toBeLessThanOrEqual(44);
    expect(attachmentBox?.height).toBeLessThanOrEqual(44);
    const emptyComposer = await page.locator(".cc-composer").boundingBox();
    expect(emptyComposer?.height).toBeLessThan(120);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    const input = page.locator(".cc-input");
    await input.fill(Array.from({ length: 30 }, (_, i) => `Review note ${i + 1}: preserve room for the messages above.`).join("\n"));
    await expect.poll(() => input.evaluate((node) => node.getBoundingClientRect().height)).toBeLessThanOrEqual(paneHeight * .32 + 2);
    expect(await input.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    // A resized card/keyboard must recompute the cap without editing the draft.
    await page.evaluate(() => { document.getElementById("root")!.style.height = "320px"; });
    await expect.poll(() => input.evaluate((node) => node.getBoundingClientRect().height)).toBeLessThanOrEqual(104);
    await input.fill("");
    await page.evaluate((paneHeight) => { document.getElementById("root")!.style.height = `${paneHeight}px`; }, paneHeight);
    await expect.poll(() => input.evaluate((node) => node.getBoundingClientRect().height)).toBeLessThanOrEqual(46);
    if (process.env.GARRISON_UI_EVIDENCE_DIR) {
      mkdirSync(process.env.GARRISON_UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.GARRISON_UI_EVIDENCE_DIR, `${name}.png`) });
    }
  });
});

afterAll(async () => {
  await page?.close();
  await context?.close();
  await browser?.close();
});

const mount = (props: Record<string, unknown> = {}) =>
  page.evaluate((p) => (window as any).__mount(p), props);
const emit = (payload: unknown) =>
  page.evaluate((p) => (window as any).__emit(p), payload);

const ledgerEvent = (id: string, payloadRef?: string) => ({
  id,
  role: "assistant",
  ts: 1,
  revision: 1,
  blocks: [{
    type: "ledger",
    kind: "delegation-returned",
    title: "review returned from codex/sol",
    seq: 60,
    ...(payloadRef ? { payloadRef } : {}),
  }],
});

describe("ConversationView", () => {
  it("makes the stream the body: header, no bubble pane, no Chat/Transcript toggle", async () => {
    await mount();
    await emit({ type: "init", available: true, live: false, events: [ledgerEvent("01CONV#1")] });

    expect(await page.locator(".cc-conv-title").textContent()).toBe("Ship the ladder");
    expect(await page.locator(".cc-session").count()).toBe(1);
    // The bubble pane and its empty state belong to the surface transcriptOnly replaces.
    expect(await page.locator(".cc-turn").count()).toBe(0);
    expect(await page.locator(".cc-empty").count()).toBe(0);
    // One header toggle survives - Raw. The Chat/Transcript switch has nothing to switch to.
    expect(await page.locator(".cc-rawtoggle").allTextContents()).toEqual(["Raw"]);
    // The composer is untouched.
    expect(await page.locator(".cc-composer .cc-input").count()).toBe(1);
    expect(await page.evaluate(() => (window as any).__streamUrls())).toEqual(["/api/conversation/01CONV/stream"]);
  });

  it("debounces the search field into ONE request and renders its hits", async () => {
    await page.evaluate(() => {
      (window as any).__searchResponse = {
        hits: [
          { conversationId: "01CONV", kind: "handoff", seq: 60, snippet: "implement -> review" },
          { conversationId: "01CONV", kind: "user-message", seq: 12, snippet: "ship the ladder" },
        ],
        truncated: true,
      };
    });
    await mount();
    await emit({ type: "init", available: true, live: false, events: [] });

    await page.locator(".cc-conv-searchinput").pressSequentially("ladder", { delay: 20 });
    await page.locator(".cc-conv-hit").first().waitFor();

    expect(await page.evaluate(() => (window as any).__searchCalls())).toEqual([
      "/api/conversation/search?q=ladder&id=01CONV",
    ]);
    expect(await page.locator(".cc-conv-hit").count()).toBe(2);
    expect(await page.locator(".cc-conv-hit").first().textContent()).toContain("implement -> review");
    expect(await page.locator(".cc-conv-hitnote").textContent()).toContain("narrow the search");

    // Escape dismisses the overlay without clearing what was typed.
    await page.keyboard.press("Escape");
    expect(await page.locator(".cc-conv-hits").count()).toBe(0);
    expect(await page.locator(".cc-conv-searchinput").inputValue()).toBe("ladder");
  });

  it("re-derives the stream URL with ?from= when a hit is clicked", async () => {
    await page.evaluate(() => {
      (window as any).__searchResponse = {
        hits: [{ conversationId: "01CONV", kind: "handoff", seq: 60, snippet: "implement -> review" }],
        truncated: false,
      };
    });
    await mount();
    await emit({ type: "init", available: true, live: false, events: [] });
    await page.locator(".cc-conv-searchinput").fill("ladder");
    await page.locator(".cc-conv-hit").first().waitFor();
    await page.locator(".cc-conv-hit").first().click();

    // seq 60 lands 40 events back, and the overlay closes behind the jump.
    await page.waitForFunction(() => (window as any).__streamUrls().length === 2);
    expect(await page.evaluate(() => (window as any).__streamUrls())).toEqual([
      "/api/conversation/01CONV/stream",
      "/api/conversation/01CONV/stream?from=20",
    ]);
    expect(await page.locator(".cc-conv-hits").count()).toBe(0);
    expect(await page.locator(".cc-conv-jumped").textContent()).toContain("#60");
  });

  it("opens a ledger payload reference in the shared modal and closes on Escape", async () => {
    await page.evaluate(() => { (window as any).__payloadBody = '{"summary":"review passed","gates":[1,2]}'; });
    await mount();
    await emit({ type: "init", available: true, live: false, events: [ledgerEvent("01CONV#60", "a1b2c3d4.json")] });

    await page.locator(".cc-ledger > summary").click();
    const ref = page.locator(".cc-ledger-ref-open");
    expect(await ref.textContent()).toContain("a1b2c3d4.json");
    await ref.click();

    const dialog = page.locator("dialog.cc-paymodal");
    expect(await dialog.getAttribute("open")).not.toBeNull();
    expect(await page.locator(".cc-paymodal-kind").textContent()).toBe("json");
    await page.locator(".cc-paymodal-pre").waitFor();
    expect(await page.locator(".cc-paymodal-pre").textContent()).toBe(
      '{\n  "summary": "review passed",\n  "gates": [\n    1,\n    2\n  ]\n}'
    );
    expect(await page.evaluate(() => (window as any).__fetches.some((u: string) => u.includes("/payload/a1b2c3d4.json")))).toBe(true);

    await page.keyboard.press("Escape");
    expect(await page.locator("dialog.cc-paymodal").count()).toBe(0);
  });

  it("flashes the focused event when a conversation opens on a hit", async () => {
    await mount({ focusSeq: 60 });
    expect(await page.evaluate(() => (window as any).__streamUrls())).toEqual([
      "/api/conversation/01CONV/stream?from=20",
    ]);
    await emit({
      type: "init",
      available: true,
      live: false,
      events: [ledgerEvent("01CONV#59"), ledgerEvent("01CONV#60")],
    });

    const flashed = page.locator(".cc-focus-flash");
    expect(await flashed.count()).toBe(1);
    expect(await flashed.getAttribute("data-session-event-id")).toBe("01CONV#60");
  });

  it("shows a just-sent message's receipt in the tail strip", async () => {
    await mount({ lifecycle: true });
    await emit({ type: "init", available: true, live: false, events: [] });

    await page.locator(".cc-input").fill("run the review duty");
    await page.locator(".cc-send-icon").click();

    const strip = page.locator(".cc-tailstrip-row");
    await strip.waitFor();
    expect(await strip.textContent()).toContain("run the review duty");
    expect(await page.locator(".cc-tailstrip .cc-lifecycle-label").textContent()).toBe("Queued");
    expect(await page.locator(".cc-tailstrip .cc-lifecycle-detail").textContent()).toBe("Position 2");
    // Still no bubble pane - the receipt is a strip, not a second transcript.
    expect(await page.locator(".cc-turn").count()).toBe(0);
  });
});


describe("suggested conversation replies", () => {
  it("lets a decision record start its first conversation with a free reply", async () => {
    await page.evaluate(() => (window as any).__mountRecord());
    await page.getByRole("textbox", { name: "Your reply" }).fill("Reviewed — close this completed decision card.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => page.getByRole("status").textContent()).toContain("Reply sent");
    expect(await page.evaluate(() => (window as any).__answers)).toEqual([{
      message: "Reviewed — close this completed decision card.", clientRequestId: "attention:01CONV:3", origin: "kanban",
    }]);
  });
  const question = { id: "handoff-8", question: "What should happen to the preserved patch?", options: [
    { label: "Drop it - stash", description: "Keep the patch for later." },
    { label: "Drop it - delete", description: "Discard this patch." },
    { label: "Merge it in", description: "Integrate the patch and verify the result." },
  ] };
  it.each([false, true])("renders clickable replies and a free field, compact=%s", async (compact) => {
    await page.setViewportSize({ width: compact ? 390 : 1100, height: 760 });
    if (compact) await page.addStyleTag({ content: kanbanSkin + "#root{max-width:330px;padding:12px;box-sizing:border-box}" });
    await page.evaluate(({ question, compact }) => { (window as any).__question = question; return (window as any).__mountQuestion(compact); }, { question, compact });
    const option = page.getByRole("button", { name: "Merge it in", exact: false });
    await option.waitFor();
    expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.getByRole("textbox", { name: "Your reply" }).isVisible()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(compact ? 390 : 1100);
    if (process.env.GARRISON_UI_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.GARRISON_UI_EVIDENCE_DIR, compact ? "question-card-phone.png" : "question-expanded.png") });
    await option.click();
    await expect.poll(() => page.locator(".cc-question").count()).toBe(0);
    const answers = await page.evaluate(() => (window as any).__answers);
    expect(answers).toEqual([{ message: "Merge it in", questionId: "handoff-8", clientRequestId: "answer:01CONV:handoff-8", origin: "kanban" }]);
  });
  it("preserves a custom reply through failure and retries the same request", async () => {
    await page.evaluate((question) => { (window as any).__question = question; (window as any).__answerStatus = 502; return (window as any).__mountQuestion(true); }, question);
    const field = page.getByRole("textbox", { name: "Your reply" });
    await field.fill("Merge only the tests, please.");
    await field.press("Enter");
    await page.locator(".cc-question-error").waitFor();
    expect(await field.inputValue()).toBe("Merge only the tests, please.");
    await page.evaluate(() => { (window as any).__answerStatus = 202; });
    await field.press("Enter");
    await expect.poll(() => page.locator(".cc-question").count()).toBe(0);
    const answers = await page.evaluate(() => (window as any).__answers);
    expect(answers).toHaveLength(2);
    expect(answers[0]).toEqual(answers[1]);
  });
  it("uses the shared question inside Conversations and removes it on a normal reply", async () => {
    await page.evaluate((question) => { (window as any).__question = question; }, question);
    await mount();
    await emit({ type: "init", available: true, live: false, events: [
      { id: "01CONV#1", role: "assistant", ts: 1, revision: 1, blocks: [{ type: "stretch", phase: "ended", stretchId: "s1", next: "needs-input", duty: "ops" }] },
    ] });
    await page.getByRole("button", { name: "Merge it in", exact: false }).waitFor();
    expect(await page.locator(".cc-question-otherinput").count()).toBe(0);
    expect(await page.locator(".cc-input").isVisible()).toBe(true);
    if (process.env.GARRISON_UI_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.GARRISON_UI_EVIDENCE_DIR, "question-conversation-desktop.png") });
    await emit({ type: "events", events: [
      { id: "01CONV#2", role: "user", ts: 2, revision: 1, blocks: [{ type: "text", text: "A different decision" }] },
    ] });
    await expect.poll(() => page.locator(".cc-question").count()).toBe(0);
  });
});
