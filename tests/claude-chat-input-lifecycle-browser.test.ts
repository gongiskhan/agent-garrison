import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const REPO = path.resolve(__dirname, "..");
const css = readFileSync(path.join(REPO, "packages/claude-chat/src/claude-chat.css"), "utf8");
let browser: Browser;
let context: BrowserContext;
let page: Page;
let bundle = "";

beforeAll(async () => {
  const built = await build({
    stdin: {
      sourcefile: "input-lifecycle-browser-entry.tsx",
      resolveDir: REPO,
      contents: `
        import * as React from "react";
        import { createRoot } from "react-dom/client";
        import { ClaudeChat } from "./packages/claude-chat/src/ClaudeChat";

        let root;
        let listener;
        window.__adornment = { mounts: 0, unmounts: 0, queueLocked: false, lastReply: null };
        function QueueAwareAdornment({ api }) {
          React.useEffect(() => {
            window.__adornment.mounts += 1;
            return () => { window.__adornment.unmounts += 1; };
          }, []);
          window.__adornment.queueLocked = api.queueLocked;
          window.__adornment.lastReply = api.lastReply;
          return React.createElement("button", {
            type: "button",
            className: "cc-mic",
            "aria-label": "Start mock voice",
            disabled: api.queueLocked,
          }, "Voice");
        }
        const composerAdornment = (api) => React.createElement(QueueAwareAdornment, { api });
        const mock = {
          inputLifecycle: true,
          sends: [],
          interrupts: [],
          answers: [],
          permissionAnswers: [],
          pinChanges: [],
          commands: [],
          rejectInterrupt: false,
          rejectAnswer: false,
          rejectPinSave: false,
          rejectNextAdmission: false,
          holdFirstAdmission: false,
          admissionResolvers: [],
          deferUploads: false,
          uploads: [],
          connect(onEvent) {
            listener = onEvent;
            onEvent({ type: "connection", state: "open" });
            return () => {};
          },
          async sendMessage(message, meta) {
            const number = mock.sends.length + 1;
            const inputId = "input-" + number;
            const receipt = {
              clientRequestId: meta.clientRequestId,
              inputId,
              state: number === 1 ? "starting" : "queued",
              acceptedAt: "2026-08-16T12:00:0" + number + "Z",
              ...(number === 1 ? {} : { position: number - 1 }),
            };
            mock.sends.push({ message, meta: { ...meta }, receipt });
            if (mock.holdFirstAdmission && number === 1) {
              await new Promise((resolve) => { mock.admissionResolvers.push(resolve); });
            }
            if (mock.rejectNextAdmission) {
              mock.rejectNextAdmission = false;
              throw new Error("admission failed");
            }
            return receipt;
          },
          releaseFirstAdmission() {
            const resolve = mock.admissionResolvers.shift();
            if (!resolve) throw new Error("no held admission");
            resolve();
          },
          async sendKey() {},
          async sendCommand(command) { mock.commands.push(command); },
          async setMode(mode) { return { mode, reached: true }; },
          async interrupt(request) {
            mock.interrupts.push({ ...request });
            if (mock.rejectInterrupt) throw new Error("<b>stop endpoint unavailable</b>");
            return { generationId: request.generationId, state: "stopping" };
          },
          async answerQuestion(answer) {
            mock.answers.push({ ...answer });
            if (mock.rejectAnswer) throw new Error('<img src=x onerror="window.__unsafe = true">');
          },
          async answerPermission(answer) {
            mock.permissionAnswers.push({ ...answer });
          },
          async fetchCommands() { return []; },
          async uploadFile(file) {
            if (!mock.deferUploads) return { path: "/tmp/unused" };
            return new Promise((resolve, reject) => {
              mock.uploads.push({ file: { ...file }, resolve, reject });
            });
          },
          resolveUpload(path = "/tmp/unused") {
            const upload = mock.uploads.shift();
            if (!upload) throw new Error("no deferred upload");
            upload.resolve({ path });
          },
        };

        window.__mock = mock;
        window.__mount = (initialHistory = [], features = { routing: true }) => {
          if (!root) root = createRoot(document.getElementById("root"));
          root.render(React.createElement(ClaudeChat, {
            key: JSON.stringify(initialHistory.map((exchange) => exchange.input?.inputId || exchange.user)),
            transport: mock,
            title: "James",
            features,
            composerAdornment,
            initialHistory,
            routeOptions: {
              targets: [{ id: "cc-sonnet-med", runtime: "agent-sdk", provider: "anthropic", model: "claude-sonnet-4-6" }],
              efforts: ["low", "medium", "high"],
              accounts: [{ name: "work", platform: "anthropic" }],
              projects: ["garrison"],
            },
            onPinChange: async (routing) => {
              mock.pinChanges.push({ ...routing });
              if (mock.rejectPinSave) throw new Error("store unavailable");
            },
          }));
          return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        };
        window.__unmount = () => {
          root?.unmount();
          root = undefined;
          listener = undefined;
        };
        window.__emit = (event) => {
          listener(event);
          return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        };
        window.__emitInput = (number, state, extra = {}) => {
          const sent = mock.sends[number - 1];
          return window.__emit({
            type: "input",
            clientRequestId: sent.receipt.clientRequestId,
            inputId: sent.receipt.inputId,
            state,
            ...extra,
          });
        };
        window.__emitAssistant = (number, text, generationId) => {
          const sent = mock.sends[number - 1];
          return window.__emit({
            type: "assistant",
            text,
            inputId: sent.receipt.inputId,
            generationId,
          });
        };
        window.__emitQuestion = (number, toolUseId) => {
          const sent = mock.sends[number - 1];
          return window.__emit({
            type: "tool",
            name: "AskUserQuestion",
            tool_use_id: toolUseId,
            questions: [{
              header: "Choose a route",
              question: "Which route should run?",
              options: [
                { label: "A", description: "Use route A" },
                { label: "B", description: "Use route B" },
              ],
            }],
            inputId: sent.receipt.inputId,
            generationId: "generation-" + number,
          });
        };
        window.__emitPermission = (number, blockGenerationId = "generation-" + number) => {
          const sent = mock.sends[number - 1];
          return window.__emit({
            type: "session_event",
            inputId: sent.receipt.inputId,
            generationId: "generation-" + number,
            event: {
              id: "permission-event-" + number,
              role: "assistant",
              ts: Date.now(),
              revision: 1,
              generationId: "generation-" + number,
              blocks: [{
                type: "permission_request",
                requestId: "permission-" + number,
                generationId: blockGenerationId,
                name: "Bash",
                displayName: "Recovered command",
                input: { command: "deploy" },
                inputComplete: true,
                status: "pending",
                suggestionsComplete: true,
              }],
            },
          });
        };
        window.__turnEndThenClickInteractiveControls = (number, status = "completed") => {
          const sent = mock.sends[number - 1];
          listener({
            type: "session_event",
            inputId: sent.receipt.inputId,
            generationId: "generation-" + number,
            event: {
              id: "turn-end-" + number,
              role: "assistant",
              ts: Date.now(),
              revision: 1,
              generationId: "generation-" + number,
              blocks: [{
                type: "turn_end",
                status,
                subtype: status === "completed" ? "success" : "runtime",
                reason: status === "completed" ? null : "runtime failed",
                stopReason: status === "completed" ? "end_turn" : null,
                terminalReason: status === "completed" ? null : "runtime",
              }],
            },
          });
          document.querySelector("button.cc-railstop:not(.cc-railstop-change)")?.click();
          document.querySelector(".cc-question-opt")?.click();
          document.querySelector(".cc-session-permission-deny")?.click();
        };
        window.__failThenClickRetry = (number) => {
          const sent = mock.sends[number - 1];
          listener({
            type: "input",
            clientRequestId: sent.receipt.clientRequestId,
            inputId: sent.receipt.inputId,
            generationId: "generation-" + number,
            state: "failed",
            reason: "runtime failed",
          });
          document.querySelector(".cc-lifecycle-stoperror button")?.click();
        };
        window.__failThenClickInteractiveControls = (number) => {
          const sent = mock.sends[number - 1];
          listener({
            type: "input",
            clientRequestId: sent.receipt.clientRequestId,
            inputId: sent.receipt.inputId,
            generationId: "generation-" + number,
            state: "failed",
            reason: "process restarted; input was not replayed",
          });
          document.querySelector(".cc-question-opt")?.click();
          document.querySelector(".cc-session-permission-deny")?.click();
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
  context = await browser.newContext({ viewport: { width: 320, height: 700 } });
  page = await context.newPage();
}, 30_000);

beforeEach(async () => {
  // setContent replaces the nodes but does not dispose React roots. Unmount the
  // prior root first so its timers cannot keep rendering into the detached tree
  // and overwrite this test's shared adornment probe.
  await page.evaluate(() => (window as any).__unmount?.());
  await page.setContent(
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style>html,body,#root{width:100%;height:100%;margin:0}${css.replace(/<\/style/gi, "<\\/style")}</style>` +
    `<div id="root"></div>`
  );
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => (window as any).__mount());
});

afterAll(async () => {
  await page?.close();
  await context?.close();
  await browser?.close();
});

const composer = () => page.getByRole("textbox", { name: "Message James" });
const button = (name: string) => page.getByRole("button", { name, exact: true });
// The generated composer owns ONE Stop now (the rail and its Stop pair are gone
// from that mode), so match the stop wherever it lives - but never the legacy
// "Stop & change", which only a non-generated host still renders.
const stopButton = () => page.locator("button.cc-stop:not(.cc-railstop-change)");

async function emitInput(number: number, state: string, extra: Record<string, unknown> = {}) {
  await page.evaluate(
    ({ number, state, extra }) => (window as any).__emitInput(number, state, extra),
    { number, state, extra }
  );
}

describe("ClaudeChat generated input lifecycle in real Chromium", () => {
  it("does not expose transcript-less PTY commands on the generated transport", async () => {
    expect(await button("Compact").count()).toBe(0);
  });

  it("retains Compact as an explicit command on legacy live-PTY transports", async () => {
    await page.evaluate(async () => {
      (window as any).__unmount();
      (window as any).__mock.inputLifecycle = false;
      await (window as any).__mount([], { routing: true });
    });

    await button("Compact").click();
    await expect.poll(() => page.evaluate(() => (window as any).__mock.commands)).toEqual(["/compact"]);
    expect(await page.evaluate(() => (window as any).__mock.sends)).toEqual([]);
  });

  it("keeps a stale phrase-era effort preference out of visible and outbound text", async () => {
    await page.evaluate(async () => {
      (window as any).__unmount();
      // `setContent` may have an opaque origin in Chromium. Install a minimal
      // storage stand-in only when native localStorage is unavailable.
      try {
        localStorage.setItem("garrison.chat.effort", "ultrathink");
      } catch {
        const values = new Map([["garrison.chat.effort", "ultrathink"]]);
        Object.defineProperty(window, "localStorage", {
          configurable: true,
          value: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, String(value)),
          },
        });
      }
      await (window as any).__mount([], { effort: true });
    });

    const selected = page.getByRole("button", { name: "Ultrathink", exact: true });
    expect(await selected.getAttribute("aria-pressed")).toBe("true");
    expect(await selected.getAttribute("title")).toBe("Set native effort to max");

    const text = "think hard is visible user text\n\nand remains byte-identical";
    await composer().fill(text);
    await button("Send").click();
    await expect.poll(() => page.evaluate(() => (window as any).__mock.sends.length)).toBe(1);

    const sent = await page.evaluate(() => (window as any).__mock.sends[0]);
    expect(sent.message).toBe(text);
    expect(sent.meta.effort).toBe("max");
    expect(await page.locator(".cc-turn .cc-user").textContent()).toBe(text);

    const normal = page.getByRole("button", { name: "Normal", exact: true });
    await normal.click();
    expect(await normal.getAttribute("aria-pressed")).toBe("true");
    await composer().fill("normal stays exact too");
    await button("Queue").click();
    await expect.poll(() => page.evaluate(() => (window as any).__mock.sends.length)).toBe(2);
    const reset = await page.evaluate(() => (window as any).__mock.sends[1]);
    expect(reset).toMatchObject({ message: "normal stays exact too", meta: { effort: "auto" } });
  });

  it("keeps the composer usable, queues with click/Enter parity, and binds late frames to the exact turn", async () => {
    await composer().fill("first message");
    await button("Send").click();
    await expect.poll(() => page.locator('[data-input-state="starting"]').count()).toBe(1);
    expect(await composer().isEnabled()).toBe(true);
    expect(await composer().evaluate((node) => node === document.activeElement)).toBe(true);
    expect(await page.getByRole("button", { name: "Start mock voice" }).isDisabled()).toBe(true);
    expect(await page.evaluate(() => (window as any).__adornment)).toMatchObject({ mounts: 1, unmounts: 0, queueLocked: true });
    expect(await stopButton().isDisabled({ timeout: 2_000 })).toBe(true);
    expect(await page.getByRole("button", { name: "Attach a file" }).isDisabled()).toBe(true);

    await emitInput(1, "running", { generationId: "generation-1" });
    expect(await stopButton().isEnabled({ timeout: 2_000 })).toBe(true);

    await composer().fill("second message");
    await composer().press("Enter");
    await expect.poll(() => page.evaluate(() => (window as any).__mock.sends.length)).toBe(2);
    expect(await page.evaluate(() => (window as any).__mock.sends.map((send: any) => send.message))).toEqual([
      "first message",
      "second message",
    ]);
    expect(await page.locator('[data-input-state="queued"]').textContent()).toContain("Position 1");
    expect(await button("Queue").isVisible({ timeout: 2_000 })).toBe(true);

    await page.evaluate(() => (window as any).__emitAssistant(1, "late first-generation reply", "generation-1"));
    const turns = page.locator(".cc-turn");
    await expect.poll(() => turns.nth(0).textContent()).toMatch(/late first-generation reply/);
    expect(await turns.nth(1).textContent()).not.toContain("late first-generation reply");

    const measurements = await page.evaluate(() => {
      const controls = [...document.querySelectorAll(".cc-input, .cc-send, .cc-railstop, .cc-mic")]
        .filter((node) => (node as HTMLElement).offsetParent !== null)
        .map((node) => ({
          name: (node as HTMLElement).textContent || node.getAttribute("aria-label") || node.className,
          height: node.getBoundingClientRect().height,
        }));
      const input = document.querySelector(".cc-input") as HTMLElement;
      input.focus();
      return {
        width: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        rootWidth: document.querySelector(".cc-root")?.scrollWidth,
        controls,
        focusShadow: getComputedStyle(input).boxShadow,
        liveRegions: document.querySelectorAll('[role="status"][aria-live]').length,
      };
    });
    expect(measurements.width).toBe(320);
    expect(measurements.documentWidth).toBeLessThanOrEqual(320);
    expect(measurements.rootWidth).toBeLessThanOrEqual(320);
    expect(measurements.controls.length).toBeGreaterThanOrEqual(4);
    expect(measurements.controls.every((control) => control.height >= 44)).toBe(true);
    expect(measurements.focusShadow).not.toBe("none");
    expect(measurements.liveRegions).toBe(1);

    await emitInput(1, "settled", { generationId: "generation-1" });
    expect(await page.locator('[data-input-state="settled"]').count()).toBe(1);
    expect(await page.locator('[data-input-state="queued"]').count()).toBe(1);
  });

  it("stops the exact generation, surfaces a text-only error, retries, and preserves queued input", async () => {
    await composer().fill("running message");
    await button("Send").click();
    await emitInput(1, "running", { generationId: "generation-1" });
    await composer().fill("queued message");
    await button("Queue").click();

    await page.evaluate(() => { (window as any).__mock.rejectInterrupt = true; });
    await stopButton().click();
    const error = page.locator(".cc-lifecycle-stoperror");
    await expect.poll(() => error.textContent()).toContain("<b>stop endpoint unavailable</b>");
    expect(await error.locator("b").count()).toBe(0);
    expect(await page.locator('[data-input-state="queued"]').count()).toBe(1);
    expect(await page.evaluate(() => (window as any).__mock.interrupts)).toEqual([
      { generationId: "generation-1" },
    ]);

    await page.evaluate(() => { (window as any).__mock.rejectInterrupt = false; });
    await error.getByRole("button", { name: "Retry stop" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__mock.interrupts.length)).toBe(2);
    expect(await page.evaluate(() => (window as any).__mock.interrupts[1])).toEqual({ generationId: "generation-1" });
    await emitInput(1, "stopped", { generationId: "generation-1", reason: "user requested" });
    expect(await page.locator('[data-input-state="stopped"]').count()).toBe(1);
    expect(await page.locator('[data-input-state="queued"]').count()).toBe(1);
  });

  it("clears a rejected stop when the exact input fails and cannot resurrect the terminal turn", async () => {
    await composer().fill("terminal race");
    await button("Send").click();
    await emitInput(1, "running", { generationId: "generation-1" });

    await page.evaluate(() => { (window as any).__mock.rejectInterrupt = true; });
    await stopButton().click();
    const retry = page.locator(".cc-lifecycle-stoperror button");
    await expect.poll(() => retry.isVisible()).toBe(true);

    // Deliver the terminal event and click the still-mounted Retry control in
    // the same JS task. The durable terminal-coordinate guard must win even if
    // React has not painted the failed state yet.
    await page.evaluate(() => (window as any).__failThenClickRetry(1));
    await expect.poll(() => page.locator('[data-input-state="failed"]').isVisible()).toBe(true);
    await expect.poll(() => page.locator(".cc-lifecycle-stoperror").count()).toBe(0);
    expect(await retry.count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__mock.interrupts)).toEqual([
      { generationId: "generation-1" },
    ]);
  });

  it("rolls back a rejected question answer, renders a safe error, and permits a successful retry", async () => {
    await composer().fill("ask me");
    await button("Send").click();
    await emitInput(1, "running", { generationId: "generation-1" });
    await page.evaluate(() => (window as any).__emitQuestion(1, "toolu-question"));
    const optionA = page.locator(".cc-question-opt").filter({ hasText: "Use route A" });
    const optionB = page.locator(".cc-question-opt").filter({ hasText: "Use route B" });

    await page.evaluate(() => { (window as any).__mock.rejectAnswer = true; });
    await optionA.click();
    const error = page.locator(".cc-question-error");
    await expect.poll(() => error.textContent()).toBe("Could not send the answer. Please try again.");
    expect(await error.locator("img").count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__unsafe ?? false)).toBe(false);
    expect(await page.locator(".cc-question-answer").count()).toBe(0);
    expect(await optionA.isEnabled()).toBe(true);

    await page.evaluate(() => { (window as any).__mock.rejectAnswer = false; });
    await optionB.click();
    await expect.poll(() => page.locator(".cc-question-answer").textContent()).toBe("B");
    expect(await error.count()).toBe(0);
    expect(await optionA.isDisabled()).toBe(true);
    expect(await page.evaluate(() => (window as any).__mock.answers)).toEqual([
      { toolUseId: "toolu-question", label: "A" },
      { toolUseId: "toolu-question", label: "B" },
    ]);
  });

  it("makes orphaned permission and question controls terminal before a stale same-task click", async () => {
    await composer().fill("turn interrupted by restart");
    await button("Send").click();
    await emitInput(1, "running", { generationId: "generation-1" });
    await page.evaluate(() => (window as any).__emitQuestion(1, "toolu-before-restart"));
    await page.evaluate(() => (window as any).__emitPermission(1));

    expect(await page.locator(".cc-question-opt").first().isEnabled()).toBe(true);
    expect(await page.locator(".cc-session-permission-deny").isEnabled()).toBe(true);
    await page.evaluate(() => (window as any).__failThenClickInteractiveControls(1));

    await expect.poll(() => page.locator('[data-input-state="failed"]').isVisible()).toBe(true);
    expect(await page.locator(".cc-question-opt").first().isDisabled()).toBe(true);
    expect(await page.locator(".cc-question-inactive").textContent()).toContain("no longer active");
    expect(await page.locator(".cc-question-error").count()).toBe(0);
    expect(await page.locator(".cc-session-permission-status").textContent()).toBe("No longer active");
    expect(await page.locator(".cc-session-permission-actions").count()).toBe(0);
    expect(await page.locator(".cc-session-permission-readonly").textContent()).toContain("no longer active");
    expect(await page.evaluate(() => (window as any).__mock.answers)).toEqual([]);
    expect(await page.evaluate(() => (window as any).__mock.permissionAnswers)).toEqual([]);
    expect(await stopButton().count()).toBe(0);
    expect(await button("Send").isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Start mock voice" }).isEnabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Attach a file" }).isEnabled()).toBe(true);
    const measurements = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      liveRegions: document.querySelectorAll('[role="status"][aria-live]').length,
    }));
    expect(measurements).toEqual({ viewport: 320, document: 320, liveRegions: 1 });
  });

  it("lets typed turn_end fence Stop, question, and permission in the same task for the exact generation", async () => {
    await composer().fill("finish with typed settlement");
    await button("Send").click();
    await emitInput(1, "running", { generationId: "generation-1" });
    await page.evaluate(() => (window as any).__emitQuestion(1, "toolu-before-terminal"));
    await page.evaluate(() => (window as any).__emitPermission(1));
    expect(await stopButton().isEnabled()).toBe(true);
    expect(await page.locator(".cc-question-opt").first().isEnabled()).toBe(true);
    expect(await page.locator(".cc-session-permission-deny").isEnabled()).toBe(true);

    await page.evaluate(() => (window as any).__turnEndThenClickInteractiveControls(1));
    await expect.poll(() => page.locator('[data-input-state="settled"]').count()).toBe(1);
    expect(await page.locator(".cc-session-notice-label").filter({ hasText: "Response complete" }).count()).toBe(1);
    expect(await stopButton().count()).toBe(0);
    expect(await page.locator(".cc-question-opt").first().isDisabled()).toBe(true);
    expect(await page.locator(".cc-session-permission-actions").count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__mock.interrupts)).toEqual([]);
    expect(await page.evaluate(() => (window as any).__mock.answers)).toEqual([]);
    expect(await page.evaluate(() => (window as any).__mock.permissionAnswers)).toEqual([]);

    // A delayed running receipt cannot resurrect controls after the typed fence.
    await emitInput(1, "running", { generationId: "generation-1" });
    expect(await page.locator('[data-input-state="settled"]').count()).toBe(1);
    expect(await stopButton().count()).toBe(0);
    expect(await page.locator('[role="alert"]').count()).toBe(0);
    expect(await page.locator('[role="status"][aria-live="polite"]').count()).toBe(1);
  });

  it("drops a turn_end whose input and generation coordinates point at different turns", async () => {
    await composer().fill("first exact turn");
    await button("Send").click();
    await emitInput(1, "running", { generationId: "generation-1" });
    await composer().fill("second queued turn");
    await button("Queue").click();

    await page.evaluate(() => {
      const second = (window as any).__mock.sends[1];
      return (window as any).__emit({
        type: "session_event",
        inputId: second.receipt.inputId,
        generationId: "generation-1",
        event: {
          id: "conflicting-terminal",
          role: "assistant",
          ts: Date.now(),
          revision: 1,
          generationId: "generation-1",
          blocks: [{
            type: "turn_end",
            status: "completed",
            subtype: "success",
            reason: null,
            stopReason: "end_turn",
            terminalReason: null,
          }],
        },
      });
    });
    expect(await page.locator('[data-input-state="running"]').count()).toBe(1);
    expect(await page.locator('[data-input-state="queued"]').count()).toBe(1);
    expect(await page.locator(".cc-session-notice-label").filter({ hasText: "Response complete" }).count()).toBe(0);
    expect(await stopButton().isEnabled()).toBe(true);
  });

  it("hydrates a failed recovery as settled history while preserving exact running and queued successors", async () => {
    const cancelledPermission = {
      id: "permission-before-restart",
      role: "assistant",
      ts: 1,
      revision: 2,
      generationId: "generation-orphan",
      blocks: [{
        type: "permission_request",
        requestId: "permission-orphan",
        generationId: "generation-orphan",
        name: "Bash",
        displayName: "Interrupted command",
        input: { command: "deploy" },
        inputComplete: true,
        status: "cancelled",
        suggestionsComplete: true,
      }],
    };
    const recovered = {
      user: "deploy the release",
      assistant: "The Web process restarted before this response completed. The input was not replayed.",
      sessionEvents: [cancelledPermission],
    };
    await page.evaluate((history) => (window as any).__mount(history), [
      recovered,
      {
        user: "inspect recovery",
        assistant: "",
        input: {
          clientRequestId: "client-successor",
          inputId: "input-successor",
          generationId: "generation-successor",
          state: "running",
        },
      },
      {
        user: "summarize next",
        assistant: "",
        input: {
          clientRequestId: "client-queued",
          inputId: "input-queued",
          state: "queued",
          position: 1,
        },
      },
    ]);

    const turns = page.locator(".cc-turn");
    expect(await turns.nth(0).textContent()).toContain("input was not replayed");
    expect(await turns.nth(0).locator("[data-input-state]").count()).toBe(0);
    expect(await turns.nth(0).locator(".cc-cursor, .cc-working").count()).toBe(0);
    expect(await turns.nth(0).locator(".cc-session-permission-status").textContent()).toBe("Cancelled");
    expect(await turns.nth(0).locator(".cc-session-permission-actions").count()).toBe(0);
    expect(await page.locator(".cc-question").count()).toBe(0);
    expect(await page.locator('[data-input-state="running"]').count()).toBe(1);
    expect(await page.locator('[data-input-state="queued"]').count()).toBe(1);
    expect(await page.locator('[data-input-state="queued"]').textContent()).toContain("Position 1");

    await stopButton().click();
    expect(await page.evaluate(() => (window as any).__mock.interrupts.at(-1))).toEqual({
      generationId: "generation-successor",
    });

    await page.evaluate((history) => (window as any).__mount(history), [recovered]);
    expect(await button("Send").isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Start mock voice" }).isEnabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Attach a file" }).isEnabled()).toBe(true);
    expect(await stopButton().count()).toBe(0);
  });

  it("uses a focusable native button to remove an attachment", async () => {
    await page.locator('input[type="file"]').setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("notes"),
    });
    const remove = page.getByRole("button", { name: "Remove notes.txt" });
    await expect.poll(() => remove.isVisible()).toBe(true);
    expect(await remove.evaluate((node) => node.tagName)).toBe("BUTTON");
    await remove.focus();
    expect(await remove.evaluate((node) => node === document.activeElement)).toBe(true);
    await remove.press("Enter");
    await expect.poll(() => remove.count()).toBe(0);
    expect(await page.locator(".cc-attachment-chip").count()).toBe(0);
  });

  it("preserves every Enter submission during upload and keeps a newer draft", async () => {
    await page.evaluate(() => {
      (window as any).__mock.deferUploads = true;
      (window as any).__mock.holdFirstAdmission = true;
      (window as any).__mock.rejectNextAdmission = true;
    });
    await page.locator('input[type="file"]').setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("notes"),
    });
    await expect.poll(() => page.evaluate(() => (window as any).__mock.uploads.length)).toBe(1);

    await composer().fill("first submitted text");
    await composer().press("Enter");
    await expect.poll(() => composer().inputValue()).toBe("");
    await page.locator('input[type="file"]').setInputFiles({
      name: "later.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("later"),
    });
    await expect.poll(() => page.evaluate(() => (window as any).__mock.uploads.length)).toBe(2);
    await composer().fill("second submitted text");
    await composer().press("Enter");
    await expect.poll(() => composer().inputValue()).toBe("");
    expect(await page.evaluate(() => (window as any).__mock.sends)).toEqual([]);

    await composer().fill("newer unsent draft");
    await page.evaluate(() => {
      (window as any).__mock.resolveUpload("/tmp/deferred-notes.txt");
      (window as any).__mock.resolveUpload("/tmp/deferred-later.txt");
    });
    await expect.poll(() => page.evaluate(() => (window as any).__mock.sends.length)).toBe(1);
    await expect.poll(() => page.locator(".cc-turn").count()).toBe(2);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as any).__mock.sends.length)).toBe(1);

    // The second mock admission would resolve immediately if invoked. Release
    // the held first admission as a rejection: only after that settlement may
    // the deferred FIFO invoke the second transport request.
    await page.evaluate(() => (window as any).__mock.releaseFirstAdmission());
    await expect.poll(() => page.evaluate(() => (window as any).__mock.sends.length)).toBe(2);

    expect(await page.evaluate(() => (window as any).__mock.sends.map((send: any) => send.message))).toEqual([
      "first submitted text\n\nAttached file:\n- /tmp/deferred-notes.txt",
      "second submitted text\n\nAttached file:\n- /tmp/deferred-later.txt",
    ]);
    const clientRequestIds = await page.evaluate(() => (
      (window as any).__mock.sends.map((send: any) => send.meta.clientRequestId)
    ));
    expect(new Set(clientRequestIds).size).toBe(2);
    expect(await page.locator(".cc-turn .cc-user").allTextContents()).toEqual([
      "first submitted text\n\nAttached file:\n- /tmp/deferred-notes.txt",
      "second submitted text\n\nAttached file:\n- /tmp/deferred-later.txt",
    ]);
    expect(await composer().inputValue()).toBe("newer unsent draft");
    expect(await page.locator('[data-input-state="failed"]').count()).toBe(1);
    expect(await page.locator('[data-input-state="queued"]').count()).toBe(1);
  });

  it("Stop restores the sent text without auto-resending or reordering the queue", async () => {
    // One Stop now. It has to put the message back: a stop that silently ate
    // what you had just sent would make "stop and change my mind" cost you the
    // words, which is why there used to be a second button for it.
    await composer().fill("change this message");
    await button("Send").click();
    await emitInput(1, "running", { generationId: "generation-1" });
    await composer().fill("already queued");
    await button("Queue").click();

    await stopButton().click();
    await expect.poll(() => composer().inputValue()).toBe("change this message");
    expect(await page.evaluate(() => (window as any).__mock.sends.map((send: any) => send.message))).toEqual([
      "change this message",
      "already queued",
    ]);
    expect(await page.evaluate(() => (window as any).__mock.interrupts)).toEqual([
      { generationId: "generation-1" },
    ]);
    expect(await page.locator(".cc-turn .cc-user").allTextContents()).toEqual([
      "change this message",
      "already queued",
    ]);
    expect(await page.locator('[data-input-state="queued"]').count()).toBe(1);
  });

  it("exposes the exact earlier voice reply even when a later admission failed", async () => {
    await composer().fill("voice turn");
    await button("Send").click();
    await emitInput(1, "running", { generationId: "generation-voice" });

    await page.evaluate(() => { (window as any).__mock.rejectNextAdmission = true; });
    await composer().fill("later typed turn");
    await button("Queue").click();
    await expect.poll(() => page.locator('[data-input-state="failed"]').count()).toBe(1);

    await page.evaluate(() => (window as any).__emitAssistant(1, "voice answer", "generation-voice"));
    await emitInput(1, "settled", { generationId: "generation-voice" });
    await expect.poll(
      () => page.evaluate(() => (window as any).__adornment.lastReply),
      { timeout: 3_000 }
    ).toMatchObject({
      text: "voice answer",
      clientRequestId: expect.any(String),
    });
    const correlation = await page.evaluate(() => ({
      reply: (window as any).__adornment.lastReply.clientRequestId,
      sent: (window as any).__mock.sends[0].meta.clientRequestId,
    }));
    expect(correlation.reply).toBe(correlation.sent);
  });

  it("hydrates running and queued inputs as controlled lifecycle records", async () => {
    await page.evaluate(() => (window as any).__mount([
      {
        user: "restored running",
        assistant: "partial",
        input: {
          clientRequestId: "restored-client-1",
          inputId: "restored-input-1",
          generationId: "restored-generation-1",
          state: "running",
        },
      },
      {
        user: "restored queued",
        assistant: "",
        input: {
          clientRequestId: "restored-client-2",
          inputId: "restored-input-2",
          state: "queued",
          position: 1,
        },
      },
    ]));
    expect(await page.locator('[data-input-state="running"]').count()).toBe(1);
    expect(await page.locator('[data-input-state="queued"]').count()).toBe(1);
    expect(await stopButton().isEnabled()).toBe(true);
    expect(await button("Queue").isVisible()).toBe(true);
    expect(await composer().isEnabled()).toBe(true);
  });

  it("rolls back a rejected async pin save and exposes a keyboard-retryable nonblocking error", async () => {
    // Route is an icon in the composer that opens a sheet; the rail (and its pin
    // menus) live inside it rather than in a standing row above the input.
    await page.locator(".cc-routebtn").click();
    await page.locator("dialog.cc-sheet").waitFor({ state: "visible" });
    const target = page.locator("button.cc-rbadge").filter({ hasText: "target" }).first();
    await target.focus();
    expect(await target.evaluate((node) => node === document.activeElement)).toBe(true);
    await target.press("Enter");
    const menu = page.locator(".cc-railmenu");
    await expect.poll(() => menu.isVisible()).toBe(true);
    expect(await menu.locator(".cc-railmenu-effect").textContent()).toBe(
      "Starts a new session for your next message."
    );

    await page.evaluate(() => { (window as any).__mock.rejectPinSave = true; });
    await menu.locator(".cc-railitem").filter({ hasText: "cc-sonnet-med" }).click();
    const saveError = page.locator(".cc-pin-save-error");
    await expect.poll(() => saveError.isVisible()).toBe(true);
    expect(await saveError.textContent()).toContain("Your previous choices were restored");
    expect(await page.locator(".cc-rbadge-pinned").filter({ hasText: "cc-sonnet-med" }).count()).toBe(0);
    expect(await composer().isEnabled()).toBe(true);
    expect(await page.locator('[role="alert"]').count()).toBe(0);
    expect(await page.locator('[role="status"][aria-live="polite"]').count()).toBe(1);

    const retry = saveError.getByRole("button", { name: "Retry save" });
    const retryBox = await retry.boundingBox();
    expect(retryBox?.width).toBeGreaterThanOrEqual(44);
    expect(retryBox?.height).toBeGreaterThanOrEqual(44);
    await retry.focus();
    expect(await retry.evaluate((node) => node === document.activeElement)).toBe(true);
    await page.evaluate(() => { (window as any).__mock.rejectPinSave = false; });
    await retry.press("Enter");
    await expect.poll(() => page.locator(".cc-pin-save").count()).toBe(0);
    expect(await page.locator(".cc-rbadge-pinned").filter({ hasText: "cc-sonnet-med" }).count()).toBe(1);
    expect(await page.evaluate(() => (window as any).__mock.pinChanges)).toEqual([
      { target: "cc-sonnet-med" },
      { target: "cc-sonnet-med" },
    ]);
    const sizes = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      root: document.querySelector(".cc-root")?.scrollWidth,
    }));
    expect(sizes).toEqual({ viewport: 320, document: 320, root: 320 });
  });
});
