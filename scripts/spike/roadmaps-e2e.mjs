#!/usr/bin/env node
// E2E walkthrough of the Roadmaps fitting against a RUNNING Garrison instance.
//
// Drives the real journey a user takes (sidebar -> roadmap -> tick -> notes ->
// manage -> send to the board) and captures a screenshot per step into
// ~/.garrison/files/roadmaps-e2e so they are reachable through the
// file-browser fitting from any machine on the tailnet.
//
// Every mutation it makes is undone at the end: the task it adds is deleted,
// the ticks are cleared, the cards it creates are removed from the board, and
// the scratch project's roadmap.json is deleted.
//
//   node scripts/spike/roadmaps-e2e.mjs [appBase] [boardBase]

import { chromium } from "playwright";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const APP = process.argv[2] || "http://127.0.0.1:8777";
const BOARD = process.argv[3] || "http://127.0.0.1:8089";
const PROJECT = "ekoa-code";
const SCRATCH = "flow-scratch";
const OUT = path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "files", "roadmaps-e2e");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const problems = [];
const created = [];
let step = 0;
const shot = async (page, name, opts = {}) => {
  step += 1;
  const file = path.join(OUT, `${String(step).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, ...opts });
  console.log(`  shot ${path.basename(file)}`);
  return file;
};
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

const api = async (method, route, body) => {
  const res = await fetch(`${APP}${route}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });

try {
  // 1. reach it the way a user does: the sidebar's Fittings group.
  console.log("\n[1] navigate from the dashboard through the sidebar");
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await page.getByRole("button", { name: /knowledge/i }).first().click();
  await page.waitForTimeout(500);
  await shot(page, "sidebar-knowledge-group", { clip: { x: 0, y: 0, width: 420, height: 1100 } });
  await page.getByRole("link", { name: "Roadmaps" }).first().click();
  await page.waitForTimeout(2500);
  check("sidebar link opens /fitting/roadmaps", page.url().includes("/fitting/roadmaps"), page.url());
  await shot(page, "picker-and-roadmap");

  // 2. the seeded roadmap
  console.log("\n[2] the seeded Ekoa roadmap");
  await page.goto(`${APP}/fitting/roadmaps/${PROJECT}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const categories = await page.locator("section[id^='f']").count();
  check("all 8 phases render", categories === 8, `${categories} sections`);
  await shot(page, "roadmap-ekoa");

  // 3. tick a task: strike-through + counter + the file on disk
  console.log("\n[3] tick a task");
  const first = page.getByRole("checkbox").first();
  await first.check();
  await page.waitForTimeout(1500);
  check("checkbox stays checked (optimistic paint + persisted)", await first.isChecked());
  const afterTick = await api("GET", `/api/roadmaps/${PROJECT}`);
  check("the file on disk says done", afterTick.body.roadmap.categories[0].items[0].done === true);
  check("the counter moved", (await page.locator("section#f0").innerText()).includes("1/10"));
  await shot(page, "task-done-struck-through", { clip: { x: 300, y: 380, width: 1140, height: 420 } });

  // 4. the note anchor
  console.log("\n[4] jump to the decisions note");
  await page.getByRole("link", { name: "notes" }).first().click();
  await page.waitForTimeout(1500);
  const noteVisible = await page.locator("section#n-f0").isVisible();
  check("the note the phase points at is on screen", noteVisible);
  await shot(page, "notes-anchor");

  // 5. manage mode: add, edit, delete - and prove ids do not renumber
  console.log("\n[5] manage mode");
  await page.goto(`${APP}/fitting/roadmaps/${PROJECT}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await page.waitForTimeout(800);
  await shot(page, "manage-mode", { clip: { x: 300, y: 180, width: 1140, height: 900 } });

  const addTask = page.getByPlaceholder("New task").first();
  await addTask.fill("E2E: uma tarefa adicionada pela UI");
  await addTask.press("Enter");
  await page.waitForTimeout(1800);
  const afterAdd = await api("GET", `/api/roadmaps/${PROJECT}`);
  const items = afterAdd.body.roadmap.categories[0].items;
  const added = items[items.length - 1];
  check("the new task got the next id, not a reused one", added.id === "f0.11", added.id);
  created.push({ kind: "item", id: added.id });
  await shot(page, "task-added", { clip: { x: 300, y: 900, width: 1140, height: 300 } });

  // 6. send to the board
  console.log("\n[6] send a task to To Do");
  await page.goto(`${APP}/fitting/roadmaps/${PROJECT}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  await page.getByRole("button", { name: "→ To Do" }).first().click();
  await page.waitForTimeout(3000);
  const afterSend = await api("GET", `/api/roadmaps/${PROJECT}`);
  const sentItem = afterSend.body.roadmap.categories[0].items[0];
  check("the item records the hand-off", sentItem.sentToKanban === "todo", String(sentItem.kanbanCardId));
  if (sentItem.kanbanCardId) created.push({ kind: "card", id: sentItem.kanbanCardId });
  await shot(page, "sent-to-board", { clip: { x: 300, y: 380, width: 1140, height: 420 } });

  // 7. the anti-duplication confirm
  console.log("\n[7] send the same task again");
  await page.getByRole("button", { name: "→ To Do" }).first().click();
  await page.waitForTimeout(2000);
  const confirm = page.getByText(/Already sent to To Do/i).first();
  check("a second send asks for confirmation", await confirm.isVisible());
  await shot(page, "duplicate-confirm", { clip: { x: 300, y: 380, width: 1140, height: 420 } });
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(800);

  // 8. the card as it landed on the board
  console.log("\n[8] the card on the Kanban board");
  const board = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  await board.goto(BOARD, { waitUntil: "domcontentloaded" });
  await board.waitForTimeout(3000);
  const cardOnBoard = sentItem.kanbanCardId
    ? await board.getByText("Correr a bateria de testes automatizados").first().isVisible().catch(() => false)
    : false;
  check("the card is visible on the board", cardOnBoard);
  await shot(board, "kanban-card");
  if (sentItem.kanbanCardId) {
    await board.goto(`${BOARD}/#card=${sentItem.kanbanCardId}`, { waitUntil: "domcontentloaded" }).catch(() => {});
  }
  await board.close();

  // 9. a project with no roadmap yet
  console.log("\n[9] a project with no roadmap");
  const scratchFile = path.join(os.homedir(), "dev", SCRATCH, "roadmap.json");
  if (existsSync(scratchFile)) throw new Error(`${scratchFile} already exists - pick another scratch project`);
  await page.goto(`${APP}/fitting/roadmaps/${SCRATCH}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  check("it offers to create one", await page.getByRole("button", { name: "Create roadmap.json" }).isVisible());
  await shot(page, "no-roadmap-yet", { clip: { x: 300, y: 180, width: 1140, height: 520 } });
  await page.getByRole("button", { name: "Create roadmap.json" }).click();
  await page.waitForTimeout(2000);
  created.push({ kind: "file", path: scratchFile });
  check("an empty roadmap now exists", existsSync(scratchFile));
  await shot(page, "created-empty", { clip: { x: 300, y: 180, width: 1140, height: 620 } });

  // 10. phone width, the way it is actually read over the tailnet
  console.log("\n[10] phone width");
  const phone = await browser.newPage({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 3 });
  await phone.goto(`${APP}/fitting/roadmaps/${PROJECT}`, { waitUntil: "domcontentloaded" });
  await phone.waitForTimeout(2500);
  const overflow = await phone.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("main *")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > window.innerWidth + 1) out.push(el.tagName);
    }
    return [...new Set(out)];
  });
  check("nothing overflows the viewport", overflow.length === 0, overflow.join(","));
  await shot(phone, "phone");
  await phone.close();

  // The duplicate-send step DELIBERATELY draws a 409, and the browser logs
  // every 4xx fetch to the console. That is the feature working, not an error.
  const unexpected = errors.filter((line) => !/status of 409/.test(line));
  check("no unexpected console or page errors", unexpected.length === 0, unexpected.slice(0, 3).join(" | "));
} finally {
  // ── undo everything ──────────────────────────────────────────────────────
  console.log("\n[cleanup]");
  for (const item of created) {
    if (item.kind === "card") {
      const res = await fetch(`${BOARD}/cards/${item.id}`, { method: "DELETE" });
      console.log(`  card ${item.id}: ${res.status}`);
    }
    if (item.kind === "file") {
      rmSync(item.path, { force: true });
      console.log(`  removed ${item.path}`);
    }
  }
  // Reset the Ekoa roadmap to the pristine seed.
  const seeded = path.join(os.homedir(), "dev", PROJECT, "roadmap.json");
  rmSync(seeded, { force: true });
  const { execFileSync } = await import("node:child_process");
  execFileSync("node", [path.resolve("scripts/spike/seed-ekoa-roadmap.mjs"), path.dirname(seeded)], { stdio: "ignore" });
  console.log(`  reseeded ${seeded}`);
  await browser.close();
}

console.log(`\n${problems.length === 0 ? "ALL CHECKS PASSED" : `FAILED: ${problems.join("; ")}`}`);
console.log(`screenshots: ${OUT}`);
process.exit(problems.length === 0 ? 0 : 1);
