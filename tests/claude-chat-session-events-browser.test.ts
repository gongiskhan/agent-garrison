import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const REPO = path.resolve(__dirname, "..");
let browser: Browser;
let context: BrowserContext;
let page: Page;
let bundle = "";
const css = [
  readFileSync(path.join(REPO, "packages/claude-chat/src/claude-chat.css"), "utf8"),
  readFileSync(path.join(REPO, "fittings/seed/web-channel-default/ui/styles.css"), "utf8"),
].join("\n");

beforeAll(async () => {
  const built = await build({
    stdin: {
      sourcefile: "session-event-browser-entry.tsx",
      resolveDir: REPO,
      contents: `
        import * as React from "react";
        import { createRoot } from "react-dom/client";
        import { SessionEventTimeline, SessionStream } from "./packages/claude-chat/src/SessionTranscript";
        class FixtureEventSource {
          onmessage = null;
          onerror = null;
          constructor() { window.__sessionSource = this; }
          close() {}
        }
        window.EventSource = FixtureEventSource;
        window.__permissionAnswers = [];
        window.__permissionBehavior = "resolve";
        let root;
        window.__mountTimeline = (events, live = false, permissionControls = false) => {
          if (!root) root = createRoot(document.getElementById("root"));
          const onPermissionDecision = permissionControls ? (answer) => {
            window.__permissionAnswers.push(answer);
            if (window.__permissionBehavior === "reject") {
              return Promise.reject(new Error("<b>permission endpoint unavailable</b>"));
            }
            return Promise.resolve();
          } : undefined;
          root.render(React.createElement(SessionEventTimeline, { events, live, onPermissionDecision }));
          return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        };
        window.__mountStream = (events, announceLiveUpdates) => {
          if (!root) root = createRoot(document.getElementById("root"));
          root.render(React.createElement(SessionStream, {
            url: "/fixture-session",
            live: true,
            announceLiveUpdates,
          }));
          return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            .then(() => {
              window.__sessionSource.onmessage({
                data: JSON.stringify({ type: "init", available: true, live: true, events }),
              });
              return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            });
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
  context = await browser.newContext({ viewport: { width: 320, height: 700 }, hasTouch: true, isMobile: true });
  page = await context.newPage();
}, 30_000);

beforeEach(async () => {
  await page.setContent(
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>` +
    `<div class="wc-xscript" style="position:relative;height:700px">` +
    `<div class="wc-xscript-head"><button type="button" class="wc-xscript-close" aria-label="Close session transcript">×</button></div>` +
    `<div class="wc-xscript-body"><div id="root"></div></div></div>`
  );
  await page.addScriptTag({ content: bundle });
  // Reset Chromium's focus-visible input modality between cases. Pointer clicks
  // in an earlier test otherwise suppress a later programmatic focus ring even
  // though the control remains keyboard focusable.
  await page.keyboard.press("Tab");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
});

afterAll(async () => {
  await page?.close();
  await context?.close();
  await browser?.close();
});

const mount = async (events: unknown[], live = false, permissionControls = false) => {
  await page.evaluate(
    ({ events, live, permissionControls }) => (window as any).__mountTimeline(events, live, permissionControls),
    { events, live, permissionControls }
  );
};

describe("claude-chat canonical timeline in a real browser", () => {
  it("preserves the stable outer Markdown node while a revision completes its fence", async () => {
    const first = [{
      id: "stable-text",
      role: "assistant",
      ts: 1,
      revision: 1,
      blocks: [{ type: "text", text: "```js\nconst answer =" }],
    }];
    await mount(first, true);
    await page.locator('[data-session-event-id="stable-text"]').evaluate((node) => {
      (window as any).__stableNode = node;
    });

    await mount([{ ...first[0], revision: 2, blocks: [{ type: "text", text: "```js\nconst answer = 42;\n```" }] }], true);
    expect(await page.evaluate(() => (window as any).__stableNode === document.querySelector('[data-session-event-id="stable-text"]'))).toBe(true);
    expect(await page.locator("pre code").textContent()).toBe("const answer = 42;\n");
  });

  it("opens the active tool, closes it on settle, and stays inside a 320px touch viewport", async () => {
    const toolName = "mcp__codex_apps__plugin_management_update_app_permissions";
    const events = [{
      id: "long-tool",
      role: "assistant",
      ts: 1,
      revision: 1,
      blocks: [{ type: "tool_use", name: toolName, toolUseId: "long-tool-id", input: "{}" }],
    }];
    await mount(events, true);
    const details = page.locator("details.cc-session-tool");
    expect(await details.getAttribute("open")).not.toBeNull();

    const measurements = await page.locator("summary").evaluate((summary) => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      summaryClientWidth: summary.clientWidth,
      summaryScrollWidth: summary.scrollWidth,
      summaryHeight: summary.getBoundingClientRect().height,
      marker: getComputedStyle(summary, "::before").content,
    }));
    expect(measurements.viewportWidth).toBe(320);
    expect(measurements.documentWidth).toBeLessThanOrEqual(measurements.viewportWidth);
    expect(measurements.summaryScrollWidth).toBeLessThanOrEqual(measurements.summaryClientWidth);
    expect(measurements.summaryHeight).toBeGreaterThanOrEqual(44);
    expect(measurements.marker).not.toBe("none");

    await mount(events, false);
    await page.waitForFunction(() => !document.querySelector("details.cc-session-tool")?.hasAttribute("open"));
  });

  it("uses a modal dialog, keeps keyboard focus inside, and restores the image opener", async () => {
    await mount([
      {
        id: "image-tool",
        role: "assistant",
        ts: 1,
        revision: 1,
        blocks: [{ type: "tool_use", name: "Read", toolUseId: "image-tool-id" }],
      },
      {
        id: "image-result",
        role: "user",
        ts: 2,
        revision: 1,
        toolResultsOnly: true,
        blocks: [{
          type: "tool_result",
          toolUseId: "image-tool-id",
          images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }],
        }],
      },
    ]);

    await page.locator("summary").click();
    const opener = page.getByRole("button", { name: "Open Read result image 1" });
    await opener.focus();
    await opener.click();
    const dialog = page.locator("dialog.cc-session-modal");
    expect(await dialog.getAttribute("open")).not.toBeNull();
    const close = page.getByRole("button", { name: "Close Read result image 1" });
    expect(await close.evaluate((node) => node === document.activeElement)).toBe(true);
    const closeBox = await close.boundingBox();
    expect(closeBox?.width).toBeGreaterThanOrEqual(44);
    expect(closeBox?.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    expect(await dialog.count()).toBe(0);
    expect(await opener.evaluate((node) => node === document.activeElement)).toBe(true);
  });

  it("keeps exactly one live region when ClaudeChat owns transcript announcements", async () => {
    const events = [{
      id: "user-prompt",
      role: "user",
      ts: 1,
      revision: 1,
      blocks: [{ type: "text", text: "Inspect it" }],
    }];
    await page.evaluate(
      ({ events }) => (window as any).__mountStream(events, false),
      { events }
    );
    expect(await page.locator(".cc-session-awaiting").textContent()).toBe("Working…");
    expect(await page.locator('.cc-session [role="status"]').count()).toBe(0);

    await page.evaluate(
      ({ events }) => (window as any).__mountStream(events, true),
      { events }
    );
    expect(await page.locator('.cc-session [role="status"]').count()).toBe(1);
  });

  it("keeps a restored standalone permission visible without inert answer buttons", async () => {
    const events = [{
      id: "standalone-permission",
      role: "assistant",
      ts: 1,
      revision: 1,
      blocks: [{
        type: "permission_request",
        requestId: "standalone-permission",
        generationId: "standalone-generation",
        name: "Write",
        input: { path: "/srv/output.txt" },
        inputComplete: true,
        blockedPath: "/srv/output.txt",
        status: "pending",
        suggestionsComplete: true,
      }],
    }];
    await page.evaluate(
      ({ events }) => (window as any).__mountStream(events, false),
      { events }
    );

    expect(await page.locator(".cc-session-permission").count()).toBe(1);
    expect(await page.locator(".cc-session-permission-readonly").textContent()).toContain("Return to chat");
    expect(await page.locator(".cc-session-permission-actions").count()).toBe(0);
  });

  it("answers permission prompts independently with 44px controls, safe errors, and retry", async () => {
    const permission = (id: string, suggestions?: unknown[]) => ({
      id: `event-${id}`,
      role: "assistant",
      ts: 1,
      revision: 1,
      blocks: [{
        type: "permission_request",
        requestId: id,
        generationId: `generation-${id}`,
        name: "Bash",
        displayName: id === "one" ? "Release command" : "Audit command",
        input: { command: "printf '<script>literal</script>'" },
        inputComplete: true,
        blockedPath: `/srv/${id}/artifact-with-a-very-long-unbroken-destination-name.txt`,
        status: "pending",
        suggestionsComplete: true,
        ...(suggestions ? { suggestions } : {}),
      }],
    });
    await mount([
      permission("one", [{ type: "addRules", rules: ["Bash(printf:*)"] }]),
      permission("two"),
    ], true, true);

    const prompts = page.locator(".cc-session-permission");
    expect(await prompts.count()).toBe(2);
    expect(await prompts.nth(0).getByRole("button", { name: "Always allow" }).count()).toBe(1);
    expect(await prompts.nth(1).getByRole("button", { name: "Always allow" }).count()).toBe(0);
    expect(await page.locator("script").filter({ hasText: "literal" }).count()).toBe(0);

    const measurements = await prompts.nth(0).evaluate((prompt) => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      promptWidth: prompt.getBoundingClientRect().width,
      promptScrollWidth: prompt.scrollWidth,
    }));
    expect(measurements.viewportWidth).toBe(320);
    expect(measurements.documentWidth).toBeLessThanOrEqual(measurements.viewportWidth);
    expect(measurements.promptScrollWidth).toBeLessThanOrEqual(Math.ceil(measurements.promptWidth));

    for (const button of await prompts.nth(0).getByRole("button").all()) {
      const box = await button.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
      await button.focus();
      const focus = await button.evaluate((node) => {
        const style = getComputedStyle(node);
        return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
      });
      expect(focus.style).not.toBe("none");
      expect(focus.width).toBeGreaterThanOrEqual(2);
    }

    await page.evaluate(() => { (window as any).__permissionBehavior = "reject"; });
    await prompts.nth(0).getByRole("button", { name: "Deny" }).click();
    await expect.poll(() => prompts.nth(0).locator(".cc-session-permission-error").textContent()).toContain("permission endpoint unavailable");
    expect(await prompts.nth(0).locator(".cc-session-permission-error b").count()).toBe(0);
    expect(await prompts.nth(0).getByRole("button", { name: "Retry Deny" }).count()).toBe(1);
    expect(await prompts.nth(1).getByRole("button", { name: "Allow once" }).isEnabled()).toBe(true);

    await page.evaluate(() => { (window as any).__permissionBehavior = "resolve"; });
    await prompts.nth(0).getByRole("button", { name: "Retry Deny" }).click();
    await expect.poll(() => prompts.nth(0).locator(".cc-session-permission-submitted").textContent()).toContain("Answer sent");
    expect(await page.evaluate(() => (window as any).__permissionAnswers)).toEqual([
      { requestId: "one", generationId: "generation-one", decision: "deny" },
      { requestId: "one", generationId: "generation-one", decision: "deny" },
    ]);
  });

  it("gives standalone transcript actions 44px targets and a visible focus ring", async () => {
    await page.locator(".wc-xscript-body").evaluate((body) => {
      body.insertAdjacentHTML(
        "beforeend",
        '<div class="cc-session" data-touch-fixture><div class="cc-related-task"><span class="cc-related-main"><b>Audit</b><span>Explore</span></span><button type="button">Open</button></div></div>'
      );
    });
    for (const control of [
      page.getByRole("button", { name: "Close session transcript" }),
      page.getByRole("button", { name: "Open" }),
    ]) {
      const box = await control.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
      await control.focus();
      const focus = await control.evaluate((node) => {
        const style = getComputedStyle(node);
        return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
      });
      expect(focus.style).not.toBe("none");
      expect(focus.width).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps shared light-theme transcript microcopy at AA contrast", async () => {
    await page.locator(".wc-xscript-body").evaluate((body) => {
      body.insertAdjacentHTML(
        "beforeend",
        '<div class="cc-root" data-theme="light" style="height:auto" data-contrast-fixture>' +
          '<div class="cc-session"><details class="cc-session-tool" open><summary>' +
            '<b>Read</b><span class="cc-session-tool-hint">artifact</span><span class="cc-session-state">done</span>' +
          '</summary><div class="cc-session-toolbody"><span class="cc-session-section-label">Result</span></div></details>' +
          '<details class="cc-related" open><summary>Related tasks</summary><div class="cc-related-list">' +
            '<div class="cc-related-task"><span class="cc-related-main"><b>Audit</b><span>Explore</span></span></div>' +
          '</div></details></div>' +
        '</div>'
      );
    });
    const ratios = await page.locator("[data-contrast-fixture]").evaluate((fixture) => {
      const luminance = (value: string) => {
        const channels = (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const linear = channels.map((channel) => {
          const component = channel / 255;
          return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const ratio = (foreground: Element, background: Element) => {
        const a = luminance(getComputedStyle(foreground).color);
        const b = luminance(getComputedStyle(background).backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      return {
        tool: ratio(
          fixture.querySelector(".cc-session-state")!,
          fixture.querySelector(".cc-session-tool")!
        ),
        related: ratio(
          fixture.querySelector(".cc-related-main > span")!,
          fixture.querySelector(".cc-related-task")!
        ),
      };
    });
    expect(ratios.tool).toBeGreaterThanOrEqual(4.5);
    expect(ratios.related).toBeGreaterThanOrEqual(4.5);
  });
});
