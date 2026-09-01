import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

// The card modal's conversation surface, driven in a real browser (this repo has
// no jsdom; the convention for a component whose behaviour is effects + DOM is an
// esbuild bundle through Playwright, as tests/conversation-view.test.ts does).
//
// What is pinned is the SEAM the board owns, not ConversationView's own
// behaviour (that has its own suite): the composer's door and the exact body it
// posts, the fact that an admitted message settles instead of leaving a pending
// receipt nothing can ever clear, that a refusal is VISIBLE rather than silently
// swallowed, the degraded-cwd marker read from the ledger's own record of where
// the stretch ran, and that a frozen card is offered no way to write.

const REPO = path.resolve(__dirname, "..");
const css = readFileSync(path.join(REPO, "packages/claude-chat/src/claude-chat.css"), "utf8");
const skin = readFileSync(path.join(REPO, "fittings/seed/kanban-loop/ui/styles.css"), "utf8");
let browser: Browser;
let context: BrowserContext;
let page: Page;
let bundle = "";

beforeAll(async () => {
  const built = await build({
    stdin: {
      sourcefile: "card-conversation-entry.tsx",
      resolveDir: REPO,
      contents: `
        import * as React from "react";
        import { createRoot } from "react-dom/client";
        import { CardConversation, createConversationTransport } from "./fittings/seed/kanban-loop/ui/card-conversation";
        window.__createTransport = createConversationTransport;

        // The transcript's SSE stream is ConversationView's business; this fixture
        // only has to keep it from throwing.
        class FixtureEventSource {
          constructor(url) { this.url = url; this.onmessage = null; this.onerror = null; window.__source = this; }
          close() {}
        }
        window.EventSource = FixtureEventSource;

        window.__posts = [];
        window.__attachmentPosts = [];
        window.__meta = { tail: [] };
        window.__messageResponse = { status: 202, body: { accepted: true, seq: 7, recordedBy: "router" } };
        window.__attachmentResponse = { status: 200, body: { name: "notes.txt", bytes: 12, path: "/abs/cards/01CARD/attachments/notes.txt" } };
        const json = (value, status = 200) => new Response(JSON.stringify(value), {
          status,
          headers: { "content-type": "application/json" },
        });
        window.fetch = (input, init) => {
          const url = typeof input === "string" ? input : String(input && input.url ? input.url : input);
          if (url.indexOf("/attachments") !== -1) {
            window.__attachmentPosts.push({ url, body: JSON.parse(init.body) });
            const r = window.__attachmentResponse;
            return Promise.resolve(json(r.body, r.status));
          }
          if (url.indexOf("/message") !== -1) {
            window.__posts.push({ url, body: JSON.parse(init.body) });
            const r = window.__messageResponse;
            return Promise.resolve(json(r.body, r.status));
          }
          if (url.indexOf("/host-map") === 0) return Promise.resolve(json({ map: {} }));
          // Anything else under the conversation base is the meta probe.
          return Promise.resolve(json(window.__meta));
        };

        window.__rawLogClicks = 0;
        const raf2 = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        let root;
        window.__mount = (props = {}) => {
          if (!root) root = createRoot(document.getElementById("root"));
          root.render(React.createElement(CardConversation, {
            conversationId: "01CARD",
            title: "Ship the ladder",
            generation: "1:ok",
            onRawLog: () => { window.__rawLogClicks++; },
            onOpenRuntimeTranscript: () => {},
            ...props,
          }));
          return raf2();
        };
        window.__emit = (payload) => {
          window.__source.onmessage({ data: JSON.stringify(payload) });
          return raf2();
        };
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
  // Both stylesheets, in the order the fitting ships them: the package base, then
  // the board skin whose --cc-* re-point is the thing under test for contrast.
  await page.setContent(
    `<style>html,body{margin:0;height:100%}#root{height:100%}` +
    `${css.replace(/<\/style/gi, "<\\/style")}\n${skin.replace(/<\/style/gi, "<\\/style")}</style>` +
    `<div id="root"></div>`
  );
  await page.addScriptTag({ content: bundle });
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
const send = async (text: string) => {
  await page.locator(".cc-input").fill(text);
  await page.locator(".cc-input").press("Enter");
};

describe("the card's conversation surface", () => {
  it("posts a typed message to the conversation router and settles the receipt", async () => {
    await mount();
    await emit({ type: "init", available: true, live: false, events: [] });
    await send("try the sonnet rung");

    await page.waitForFunction(() => (window as any).__posts.length === 1);
    const posts = await page.evaluate(() => (window as any).__posts);
    expect(posts[0].url).toBe("/api/conversation/01CARD/message");
    // The router's allowed-fields gate is exact - anything else is a 400.
    expect(Object.keys(posts[0].body).sort()).toEqual(["clientRequestId", "message", "origin"]);
    expect(posts[0].body.message).toBe("try the sonnet rung");
    expect(posts[0].body.origin).toBe("kanban");

    // An admitted message SETTLES: the tail strip clears instead of leaving a
    // "queued" receipt spinning on work this door never promised to follow.
    await page.waitForFunction(() => document.querySelectorAll(".cc-tailstrip-row").length === 0);
    expect(await page.locator(".cc-input").isEditable()).toBe(true);
  });

  it("makes a refused message visible instead of swallowing it", async () => {
    await page.evaluate(() => {
      (window as any).__messageResponse = {
        status: 502,
        body: { error: "the conversation responder is unreachable; the message was NOT recorded" },
      };
    });
    await mount();
    await emit({ type: "init", available: true, live: false, events: [] });
    await send("are you there");

    // A refusal renders as a structured failure notice in the tail strip. It has
    // to be structured: the strip shows a failed receipt only when it carries a
    // FailureInfo, so a bare Error here would be a message that disappeared.
    const notice = page.locator(".cc-tailstrip-row .cc-session-error").first();
    await notice.waitFor();
    expect(await notice.textContent()).toContain("was NOT recorded");
  });

  it("says so when the stretch could not run in the project the card names", async () => {
    await page.evaluate(() => {
      (window as any).__meta = {
        tail: [
          { kind: "user-message", payload: { text: "go" } },
          { kind: "stretch-started", payload: { project: "ekoa-code", cwd: null, cwdDegraded: true } },
        ],
      };
    });
    await mount();
    await emit({ type: "init", available: true, live: false, events: [] });

    const marker = page.locator(".conv-degraded");
    await marker.waitFor();
    expect(await marker.textContent()).toContain("ekoa-code is not on this machine");
    // A plain-text marker, never an emoji (project UI rule).
    expect(await marker.textContent()).toMatch(/^[\x20-\x7E]+$/);
  });

  it("shows no marker when the stretch ran where the card said", async () => {
    await page.evaluate(() => {
      (window as any).__meta = {
        tail: [{ kind: "stretch-started", payload: { project: "garrison", cwd: "/home/x/dev/garrison", cwdDegraded: false } }],
      };
    });
    await mount();
    await emit({ type: "init", available: true, live: false, events: [] });
    expect(await page.locator(".conv-degraded").count()).toBe(0);
  });

  it("offers the raw phase log from the conversation header", async () => {
    await mount();
    await emit({ type: "init", available: true, live: false, events: [] });
    await page.locator(".conv-rawlog").click();
    expect(await page.evaluate(() => (window as any).__rawLogClicks)).toBe(1);
  });

  it("gives a frozen card no way to write into its record", async () => {
    await mount({ frozen: true });
    await emit({ type: "init", available: true, live: false, events: [] });

    // The composer is suppressed, and the record it sits under is still readable.
    expect(await page.locator(".cc-composer").isVisible()).toBe(false);
    expect(await page.locator(".cc-session").count()).toBe(1);

    // Belt and braces: the transport itself refuses, so a control reached some
    // other way still writes nothing into history.
    const refusal = await page.evaluate(async () => {
      const transport = (window as any).__createTransport("01CARD", { frozen: true });
      try {
        await transport.sendMessage("write into the record", { clientRequestId: "x" });
        return "accepted";
      } catch (err: any) {
        return String(err?.message ?? err);
      }
    });
    expect(refusal).toContain("frozen");
    expect(await page.evaluate(() => (window as any).__posts.length)).toBe(0);
  });

  it("uploads a message-composer attachment as a card-owned upload", async () => {
    const result = await page.evaluate(async () => {
      const transport = (window as any).__createTransport("01CARD", {});
      const up = await transport.uploadFile({ name: "notes.txt", mime: "text/plain", base64: "aGVsbG8=" });
      return { up, posts: (window as any).__attachmentPosts };
    });
    // Same wire shape and endpoint as the Detail sheet's own uploads, so it
    // folds into the same cards/<id>/attachments/ directory and every future
    // stretch brief for free.
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0].url).toBe("/cards/01CARD/attachments");
    expect(result.posts[0].body).toEqual({ filename: "notes.txt", content_base64: "aGVsbG8=" });
    expect(result.up).toEqual({ path: "/abs/cards/01CARD/attachments/notes.txt", bytes: 12 });
  });

  it("gives a frozen card no message-composer upload door either", async () => {
    const hasUpload = await page.evaluate(() => {
      const transport = (window as any).__createTransport("01CARD", { frozen: true });
      return typeof transport.uploadFile === "function";
    });
    expect(hasUpload).toBe(false);
  });
});
