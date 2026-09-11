import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { cardsHarness } from "./helpers/cards-conversation-harness";
// @ts-ignore JavaScript service boundary
import { ensureThread, renameThread, deleteThread } from "../packages/talk/src/threads.mjs";
// @ts-ignore JavaScript service boundary
import { openConversation } from "@garrison/claude-pty";
// @ts-ignore JavaScript service boundary
import { loadCard } from "../fittings/seed/kanban-loop/lib/board.mjs";

const evidence = path.resolve("evidence/cards-from-conversations");
let harness: Awaited<ReturnType<typeof cardsHarness>>, browser: Browser, page: Page;
const workId = "work-card-journey", zecaId = "zeca-card-journey";
let z1Card: string;
const screenshots: string[] = [];
async function shot(name: string) { const file = path.join(evidence, name + ".png"); await page.screenshot({ path: file, fullPage: false }); screenshots.push(file); }
async function json(route: string, body?: object, method = "POST") {
  const response = await fetch(harness.base + route, { method: body ? method : "GET", ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await response.json(); if (!response.ok) throw new Error(JSON.stringify(data)); return data;
}
async function seedZeca(id: string, count = 20) {
  await ensureThread({ id, source: "zeca", title: "Zeca" }); const store = openConversation(id, { role: "test" }); store.init({});
  for (let i = 0; i < count; i++) {
    const text = i < 10 ? (i % 2 ? "A shaded walking route near the river sounds good." : "Let's compare weekend walking routes and shaded paths.")
      : (i % 2 ? "Keep local times and show the next three reminders in an offline preview." : "Build an offline reminder preview. Keep local times and show the next three reminders.");
    if (i % 2) {
      const stretch = `fixture-reply-${i}`;
      store.append({ kind: "stretch-started", stretch, payload: { stretchId: stretch, duty: "responder", target: { model: "fixture" } } });
      store.append({ kind: "session-event", stretch, payload: { id: `answer-${i}`, role: "assistant", blocks: [{ type: "text", text }] } });
      store.append({ kind: "stretch-ended", stretch, payload: { stretchId: stretch, outcome: "complete", next: "done" } });
    } else store.append({ kind: "user-message", payload: { text } });
  }
  return store;
}
async function openZeca(id = zecaId, mobile = false) {
  await page.goto(`${harness.base}/talk?thread=${id}`);
  if (mobile) { await page.locator('.wc-card-overflow summary').click(); await page.locator('.wc-card-overflow button').click(); }
  else await page.locator('.wc-create-card').click();
  await page.getByLabel("Title", { exact: true }).waitFor();
}
async function createFromModal() {
  await page.getByLabel("Project", { exact: true }).selectOption("garrison");
  const response = page.waitForResponse((res) => res.url().endsWith("/api/cards/from-zeca") && res.request().method() === "POST");
  await page.getByRole("dialog", { name: "Create a card from this conversation" }).getByRole("button", { name: "Create card", exact: true }).click();
  const result = await response; expect(result.status()).toBe(201); return result.json();
}
beforeAll(async () => {
  fs.mkdirSync(evidence, { recursive: true }); harness = await cardsHarness();
  await ensureThread({ id: workId, source: "chat" }); await seedZeca(zecaId);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  page.setDefaultTimeout(12_000); page.on("pageerror", (error) => console.error(error.message));
}, 40_000);
afterAll(async () => {
  if (harness) fs.writeFileSync(path.join(evidence, "harness-log.txt"), harness.logs());
  fs.writeFileSync(path.join(evidence, "screenshots.json"), JSON.stringify(screenshots, null, 2));
  await browser?.close(); await harness?.stop();
});

describe.sequential("live local cards from conversations", () => {
  it("S1: creates on first message, syncs the title and opens the same conversation", async () => {
    await page.goto(`${harness.base}/talk?thread=${workId}`);
    expect(await page.locator('.wc-create-card').count()).toBe(0);
    const message = "Check **reminder times**\n\n- Preserve the original markdown";
    const started = Date.now();
    await json(`/api/conversation/${workId}/message`, { message, clientRequestId: "journey-first", routing: { target: "codex-astra", duty: "responder", effort: "low", project: "garrison" } });
    expect(Date.now() - started).toBeLessThan(1000);
    await expect.poll(async () => (await loadCard(harness.boardRoot, workId)).list).toBe("running");
    await expect.poll(() => harness.runtimeCalls().length).toBe(1);
    const card = await loadCard(harness.boardRoot, workId);
    expect(card.description).toMatch(/^Work session started .*\+00:00 on test-node\n\nCheck \*\*reminder times\*\*/);
    expect(card.description.endsWith(message)).toBe(true); expect(card.conversationId).toBe(workId);
    const store = openConversation(workId, { role: "test" });
    expect(store.writeSummary({ ...store.parseSummary(), objective: "Verify reminder times" }, { stretchId: store.currentStretch() }).ok).toBe(true);
    await page.reload();
    await expect.poll(async () => (await loadCard(harness.boardRoot, workId)).title).toBe("Verify reminder times");
    await page.locator('.wc-board-chip').waitFor(); await shot("s1-chip-1280");
    await page.locator('.wc-board-chip').click();
    await page.getByRole("dialog").waitFor(); await shot("s1-card-1280");
    expect(await page.locator('.kanban-conversation').count()).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Close", exact: true }).click(); await shot("s1-board-1280");
  }, 30_000);
  it("S2: follows child exit and a resumed runtime", async () => {
    const call = harness.runtimeCalls()[0]; fs.writeFileSync(call.release, "done");
    await expect.poll(async () => (await loadCard(harness.boardRoot, workId)).list).toBe("done");
    await page.reload(); await shot("s2-done-1280");
    await json(`/api/conversation/${workId}/message`, { message: "Continue the reminder check", clientRequestId: "journey-resume" });
    await expect.poll(async () => (await loadCard(harness.boardRoot, workId)).list).toBe("running");
    await page.reload(); await shot("s2-running-1280");
    const running = await loadCard(harness.boardRoot, workId);
    await json(`/cards/${workId}`, { rev: running.rev, list: "done" }, "PATCH");
    expect(() => process.kill(harness.runtimeCalls().at(-1).pid, 0)).not.toThrow();
    await json(`/api/conversation/${workId}/cancel`, {});
    await expect.poll(() => openConversation(workId, { role: "test" }).currentStretch()).toBeNull();
    await expect.poll(async () => (await loadCard(harness.boardRoot, workId)).list).toBe("done");
    await json(`/api/conversation/${workId}/message`, { message: "Check crash recovery", clientRequestId: "journey-crash" });
    await expect.poll(() => harness.runtimeCalls().length).toBe(3);
    process.kill(harness.runtimeCalls().at(-1).pid, "SIGKILL");
    await expect.poll(async () => (await loadCard(harness.boardRoot, workId)).list).toBe("done");
  }, 30_000);
  it("S3: keeps a manual card title after conversation renaming", async () => {
    await page.goto(`${harness.base}/embed/kanban-loop?card=${workId}`);
    await page.locator('.sheet-title-edit').click();
    await page.locator('.sheet-title-input').fill("My reminder check"); await page.locator('.sheet-title-input').press("Enter");
    await expect.poll(async () => (await loadCard(harness.boardRoot, workId)).titleLocked).toBe(true);
    await renameThread(workId, "Another conversation title");
    expect((await loadCard(harness.boardRoot, workId)).title).toBe("My reminder check");
  });
  it.each(["card", "conversation"])("keeps approval in To do and resumes from the %s", async (surface) => {
    const id = `approval-${surface}-journey`;
    await ensureThread({ id, source: "chat" });
    const callsBefore = harness.runtimeCalls().length;
    await json(`/api/conversation/${id}/message`, { message: "Plan an implementation that needs approval", clientRequestId: "journey-approval", routing: { target: "codex-astra", duty: "triage", project: "garrison" } });
    await expect.poll(() => harness.runtimeCalls().length).toBe(callsBefore + 1);
    fs.writeFileSync(harness.runtimeCalls().at(-1).release, JSON.stringify({ next: "implement" }));
    await expect.poll(async () => (await loadCard(harness.boardRoot, id)).awaitingApproval?.next).toBe("implement");
    // Wait for the finally hook as well as the earlier approval PATCH.
    await expect.poll(async () => (await (await fetch(`${harness.gatewayUrl}/conversation/${id}`)).json()).advancing).toBe(false);
    const waiting = await loadCard(harness.boardRoot, id);
    expect(waiting.list).toBe("todo");
    await page.goto(surface === "card" ? `${harness.base}/embed/kanban-loop?card=${id}` : `${harness.base}/talk?thread=${id}`);
    const approval = surface === "card" ? page.getByRole("dialog").locator(".approval-ask") : page.locator(".cc-conv-state-approval");
    if (surface === "conversation") {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByPlaceholder("Write a message…").fill("Keep my draft");
      await page.route(`**/api/conversation/${id}/message`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Approval temporarily unavailable"}' }), { times: 1 });
      await approval.getByRole("button", { name: "Approve & continue" }).click();
      await approval.getByRole("alert").waitFor();
      expect(harness.runtimeCalls().length).toBe(callsBefore + 1);
      expect((await loadCard(harness.boardRoot, id)).list).toBe("todo");
      await shot("approval-conversation-390");
    }
    await approval.getByRole("button", { name: "Approve & continue" }).click();
    await expect.poll(() => harness.runtimeCalls().length).toBe(callsBefore + 2);
    expect(await loadCard(harness.boardRoot, id)).toMatchObject({ list: "running", awaitingApproval: null });
    expect(harness.runtimeCalls().at(-1).brief).toContain("## Your duty: implement");
    if (surface === "conversation") {
      expect(await page.getByPlaceholder("Write a message…").inputValue()).toBe("Keep my draft");
      await expect.poll(() => page.locator(".cc-approval-button").count()).toBe(0);
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await json(`/api/conversation/${id}/cancel`, {});
    await expect.poll(() => openConversation(id, { role: "test" }).currentStretch()).toBeNull();
  }, 30_000);
  it("S4: keeps empty work conversations off the board and hides Create card", async () => {
    await ensureThread({ id: "empty-work-journey", source: "chat" }); await page.goto(`${harness.base}/talk?thread=empty-work-journey`);
    await page.getByPlaceholder("Write a message…").waitFor();
    expect(await page.locator('.wc-create-card').count()).toBe(0); expect(await page.locator('.wc-board-chip').count()).toBe(0);
    expect((await fetch(`${harness.base}/cards/empty-work-journey`)).status).toBe(404);
  });
  it("Z1: creates a self-contained To do card with source and timeline links", async () => {
    await openZeca();
    expect(await page.locator('.zc-window').textContent()).toContain("Drawn from the last 10 messages");
    expect(await page.getByLabel("Title", { exact: true }).inputValue()).toBe("Build an offline reminder preview"); await shot("z1-modal-1280");
    const result = await createFromModal(); z1Card = result.cardId;
    expect(result.state).toBe("todo"); await shot("z1-toast-1280");
    const card = await loadCard(harness.boardRoot, z1Card);
    for (const section of ["Task", "Decisions already made", "Open questions", "Context", "Source: Zeca conversation"]) expect(card.description).toContain(section);
    await page.locator('.wc-push-toast').getByRole("link", { name: "Open card" }).click(); await page.getByRole("dialog").waitFor(); await shot("z1-card-1280");
    await page.getByRole("link", { name: "From Zeca", exact: true }).click();
    expect(page.url()).toContain(`thread=${zecaId}&message=`);
    await page.getByText("Card created from this conversation: Build an offline reminder preview", { exact: true }).waitFor();
  }, 30_000);
  it("Z2: widens by ten and reruns inference", async () => {
    await openZeca(); const before = harness.inferenceCalls();
    await page.getByRole("button", { name: "Include earlier messages" }).click();
    await expect.poll(() => page.locator('.zc-window').textContent()).toContain("Drawn from the last 20 messages");
    expect(harness.inferenceCalls()).toBe(before + 1);
    expect(await page.getByLabel("Description", { exact: true }).inputValue()).toContain("Also discussed: weekend walking routes");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });
  it("Z3: creates from a verbatim fallback after inference failure", async () => {
    const id = "zeca-fallback-journey"; const store = await seedZeca(id); harness.failInference(true);
    try {
      await openZeca(id); await page.getByText("Couldn't summarise, showing the last messages instead.", { exact: true }).waitFor();
      expect(await page.getByLabel("Description", { exact: true }).inputValue()).toContain("**You** ·");
      await createFromModal(); expect(store.tail(1, { kinds: ["card.created_from_zeca"] })[0].payload.fallbackUsed).toBe(true);
    } finally { harness.failInference(false); }
  });
  it("Z4: uses the board default route and description for Start now", async () => {
    await seedZeca("zeca-start-journey"); await openZeca("zeca-start-journey"); await page.getByLabel("Start now", { exact: true }).check();
    const before = harness.runtimeCalls().length; const result = await createFromModal();
    expect(result).toMatchObject({ state: "running" });
    await expect.poll(async () => (await loadCard(harness.boardRoot, result.cardId)).list).toBe("running");
    await expect.poll(() => harness.runtimeCalls().length).toBe(before + 1);
    const call = harness.runtimeCalls().at(-1);
    expect(call.model).toBe("gpt-6-astra"); expect(call.effort).toBe("low"); expect(call.brief).toContain("## Task\nBuild an offline preview");
    await json(`/api/conversation/${result.cardId}/cancel`, {});
  }, 30_000);
  it("Z5: schedules one hour ahead with the shared picker", async () => {
    await seedZeca("zeca-schedule-journey"); await openZeca("zeca-schedule-journey"); await page.getByLabel("Schedule", { exact: true }).check();
    await page.getByRole("button", { name: "Scheduled time", exact: true }).click();
    const next = new Date(Date.now() + 3600_000); next.setSeconds(0, 0);
    await page.getByLabel("Scheduled time time").fill(`${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`);
    await page.getByRole("button", { name: "Today", exact: true }).click();
    const result = await createFromModal(); expect(result.state).toBe("scheduled");
    const card = await loadCard(harness.boardRoot, result.cardId); expect(Date.parse(card.schedule.at)).toBe(next.getTime());
    await page.locator('.wc-push-toast').getByRole("link", { name: "Open card" }).click(); await page.getByRole("dialog").waitFor(); await shot("z5-scheduled-1280");
  });
  it("Z6: starts after the last card and widens beyond an empty boundary", async () => {
    await openZeca();
    expect(await page.locator('.zc-window').textContent()).toContain("Drawn from the 0 messages since the last card");
    expect(await page.getByLabel("Description", { exact: true }).inputValue()).toBe("");
    await page.getByText("Give the card a description.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Include earlier messages" }).click();
    await expect.poll(() => page.locator('.zc-window').textContent()).toContain("Drawn from the last 20 messages");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });
  it("Z7: creates from the phone overflow and full-screen modal", async () => {
    await seedZeca("zeca-phone-journey"); await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${harness.base}/talk?thread=zeca-phone-journey`);
    await page.locator('.wc-card-overflow summary').click(); await shot("z7-overflow-390");
    await page.locator('.wc-card-overflow button').click(); await page.getByLabel("Title", { exact: true }).waitFor();
    const box = await page.locator('.zeca-card-sheet').boundingBox(); expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390); await shot("z7-modal-390");
    const result = await createFromModal(); expect(result.state).toBe("todo"); await shot("z7-toast-390");
  });
  it("retains edited values through a creation error and Retry", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const id = "zeca-retry-journey", store = await seedZeca(id); await openZeca(id);
    await page.getByLabel("Title", { exact: true }).fill("My reminder preview");
    await page.getByLabel("Description", { exact: true }).fill("## Task\nUse the local reminder times.");
    await page.getByLabel("Project", { exact: true }).selectOption("garrison");
    await page.route("**/api/cards/from-zeca", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"The board is temporarily unavailable."}' }), { times: 1 });
    await page.getByRole("dialog").getByRole("button", { name: "Create card", exact: true }).click();
    await page.locator('.wc-push-toast').getByRole("button", { name: "Retry", exact: true }).click();
    expect(await page.getByLabel("Title", { exact: true }).inputValue()).toBe("My reminder preview");
    expect(await page.getByLabel("Description", { exact: true }).inputValue()).toBe("## Task\nUse the local reminder times.");
    await createFromModal();
    expect(store.tail(1, { kinds: ["card.created_from_zeca"] })[0].payload).toMatchObject({ titleEdited: true, descriptionEdited: true });
  });
  it("validates title, project and time and hides widening at fifty", async () => {
    await seedZeca("zeca-validation-journey"); await openZeca("zeca-validation-journey");
    for (let i = 0; i < 4; i++) {
      const before = harness.inferenceCalls(); await page.getByRole("button", { name: "Include earlier messages" }).click();
      await expect.poll(() => harness.inferenceCalls()).toBe(before + 1); await page.getByLabel("Title", { exact: true }).waitFor();
    }
    expect(await page.getByRole("button", { name: "Include earlier messages" }).count()).toBe(0);
    await page.getByLabel("Title", { exact: true }).fill(""); await page.getByLabel("Schedule", { exact: true }).check();
    await page.getByRole("dialog").getByRole("button", { name: "Create card", exact: true }).click();
    for (const text of ["Give the card a title.", "Choose a project.", "Pick a time."]) await page.getByText(text, { exact: true }).waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });
  it("shows the unavailable origin without a link after source deletion", async () => {
    expect(await deleteThread(zecaId)).toBe(true);
    await page.goto(`${harness.base}/embed/kanban-loop?card=${z1Card}`);
    await page.getByText("From Zeca (conversation no longer available)", { exact: true }).waitFor();
    expect(await page.getByRole("link", { name: /^From Zeca/ }).count()).toBe(0);
  });
  it("opens an assistant message when it is the first included source", async () => {
    await seedZeca("zeca-assistant-journey", 21); await openZeca("zeca-assistant-journey");
    const result = await createFromModal();
    await page.goto(`${harness.base}/embed/kanban-loop?card=${result.cardId}`);
    await page.getByRole("link", { name: "From Zeca", exact: true }).click();
    await page.getByPlaceholder("Write a message…").waitFor();
    await page.locator('.cc-focus-flash').waitFor();
    expect(await page.locator('.cc-focus-flash').textContent()).toContain("Keep local times");
  });
  it("disables the empty Zeca button and omits it from the native app", async () => {
    await ensureThread({ id: "zeca-empty-journey", source: "zeca" });
    await page.goto(`${harness.base}/talk?thread=zeca-empty-journey`);
    await page.locator('.wc-create-card').waitFor(); expect(await page.locator('.wc-create-card').isDisabled()).toBe(true);
    const native = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    await native.addInitScript(() => { (window as any).Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios" }; });
    await native.goto(`${harness.base}/talk?thread=zeca-phone-journey`); await native.getByPlaceholder("Write a message…").waitFor();
    expect(await native.locator('.wc-create-card, .wc-card-overflow').count()).toBe(0); await native.close();
  });
});
