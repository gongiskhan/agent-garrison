// DRILL-EVIDENCE-V1 acceptance: one real Full Drill run through the real
// stack (browser-default + automations + kanban-loop + drill, spawned from
// this checkout's seed dirs against a dedicated GARRISON home), producing a
// playable webm, a consistent steps.json, viewable trace chunks, an
// evidence.json index, a run report linking into the evidence, and a REAL
// kanban card carrying the links. Playwright (repo dep) then verifies the
// video actually plays and screenshots the drill run view + the card.
// Artifacts are KEPT under the directory passed as argv[2].
//
// Lives under .claude/skills/run-garrison/ so `import "playwright"` resolves
// the repo node_modules (same constraint as driver.mjs).
import { mkdirSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT = path.resolve(process.argv[2] || path.join(REPO, ".acceptance-drill-evidence"));
const HOME = path.join(OUT, "garrison-home");
const ADIR = path.join(OUT, "automations-dir");
const TARGET = path.join(OUT, "target-repo");
for (const d of [OUT, HOME, ADIR, TARGET]) mkdirSync(d, { recursive: true });

const [FIXTURE_PORT, BROWSER_PORT, AUTOMATIONS_PORT, KANBAN_PORT, DRILL_PORT, STUB_PORT] = [7371, 7372, 7373, 7375, 7376, 7374];
const DRILL = `http://127.0.0.1:${DRILL_PORT}`;
const KANBAN = `http://127.0.0.1:${KANBAN_PORT}`;

const kids = [];
const kid = (args, env) => {
  const c = spawn("node", args, { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ...env } });
  kids.push(c);
  return c;
};
// A thrown assertion must never orphan the stack (an inherited-stdio orphan
// also wedges any pipe reading this script's output).
const cleanup = () => {
  for (const c of kids) { try { c.kill("SIGTERM"); } catch {} }
  try { stub.close(); } catch {}
};
process.on("uncaughtException", (err) => { console.error(err); cleanup(); setTimeout(() => process.exit(1), 1500); });
process.on("unhandledRejection", (err) => { console.error(err); cleanup(); setTimeout(() => process.exit(1), 1500); });
const waitHealthy = async (base, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/health`)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${base} not healthy in ${ms}ms`);
};
const jpost = async (base, p, body) => {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p} ${r.status}: ${JSON.stringify(j)}`);
  return j;
};
const assert = (cond, label) => {
  if (!cond) throw new Error(`ACCEPTANCE FAILED: ${label}`);
  console.log(`  ok: ${label}`);
};

// ── vision stub (mirrors on-screen reality, from drill-selftest) ─────────
const stub = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch {}
    res.writeHead(200, { "content-type": "application/json" });
    const desc = String(body.step?.description ?? "").toLowerCase();
    if (body.mode === "fix") return res.end(JSON.stringify({ result: { patch: "abort", reasoning: "stub: genuine failure" } }));
    if (desc.includes("cancel")) {
      const w = Number(body.observation?.viewport?.w ?? 0);
      const visible = w === 0 || w >= 500;
      return res.end(JSON.stringify({ result: { passed: visible, reasoning: visible ? "cancel visible" : "cancel hidden at this width" } }));
    }
    return res.end(JSON.stringify({ result: { passed: true, reasoning: "stub pass" } }));
  });
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

// ── the stack, from THIS checkout's seed dirs ────────────────────────────
kid([path.join(REPO, "fittings/seed/drill/test-fixtures/serve.mjs")], { PORT: String(FIXTURE_PORT) });
kid([path.join(REPO, "fittings/seed/browser-default/scripts/start.mjs"), "--port", String(BROWSER_PORT), "--host", "127.0.0.1"], { GARRISON_HOME: HOME });
await waitHealthy(`http://127.0.0.1:${BROWSER_PORT}`, 20000);
kid([path.join(REPO, "fittings/seed/automations/scripts/start.mjs")], {
  GARRISON_HOME: HOME, GARRISON_AUTOMATIONS_DIR: ADIR,
  GARRISON_BROWSER_URL: `http://127.0.0.1:${BROWSER_PORT}`,
  GARRISON_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
  AUTOMATIONS_UI_PORT: String(AUTOMATIONS_PORT), AUTOMATIONS_UI_HOST: "127.0.0.1"
});
await waitHealthy(`http://127.0.0.1:${AUTOMATIONS_PORT}`, 10000);
// The board file must exist before the server answers /board (a real
// deployment seeds it at fitting setup; same as tests/kanban-add-card).
{
  const { seedBoard } = await import(path.join(REPO, "fittings/seed/kanban-loop/scripts/kanban.mjs"));
  const { saveBoard } = await import(path.join(REPO, "fittings/seed/kanban-loop/lib/board.mjs"));
  mkdirSync(path.join(HOME, "kanban-loop", "cards"), { recursive: true });
  await saveBoard(seedBoard(), path.join(HOME, "kanban-loop"));
}
kid([path.join(REPO, "fittings/seed/kanban-loop/scripts/start.mjs")], {
  GARRISON_HOME: HOME, GARRISON_KANBAN_DIR: path.join(HOME, "kanban-loop"),
  GARRISON_RUNS_DIR: path.join(HOME, "runs"), GARRISON_POLICY_PATH: path.join(HOME, "no-policy.json"),
  KANBAN_UI_PORT: String(KANBAN_PORT), KANBAN_UI_HOST: "127.0.0.1"
});
await waitHealthy(KANBAN, 15000);
kid([path.join(REPO, "fittings/seed/drill/scripts/start.mjs")], {
  GARRISON_HOME: HOME, GARRISON_DRILL_TARGET_REPO: TARGET,
  GARRISON_BROWSER_URL: `http://127.0.0.1:${BROWSER_PORT}`,
  DRILL_UI_PORT: String(DRILL_PORT), DRILL_UI_HOST: "127.0.0.1"
});
await waitHealthy(DRILL, 10000);
console.log("stack up: fixture + browser + automations + kanban + drill");

// ── the Drill Book: 2 pages, 2 viewports, one real mobile CSS bug ────────
const FIX = `http://127.0.0.1:${FIXTURE_PORT}`;
await fetch(`${DRILL}/api/drillbook`, {
  method: "PATCH", headers: { "content-type": "application/json" },
  body: JSON.stringify({ app: { name: "drill-fixture", url: `${FIX}/chat.html` }, autonomy: "auto", viewports: ["desktop", "mobile"] })
});
await fetch(`${DRILL}/api/pages/chat`, {
  method: "PUT", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    title: "Chat", path: "/chat.html", areas: [],
    steps: [
      { id: "s-answer", area: 0, mode: "e2e", enabled: true, state: "default", viewports: ["desktop", "mobile"], description: "answer is visible", assertion: { kind: "visible", testId: "answer" }, tags: [] }
    ]
  })
});
await fetch(`${DRILL}/api/pages/build`, {
  method: "PUT", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    title: "Build", path: "/build.html", areas: [],
    steps: [
      { id: "s-progress", area: 0, mode: "e2e", enabled: true, state: "default", viewports: ["desktop", "mobile"], description: "progress bar visible", assertion: { kind: "visible", testId: "progress-bar" }, tags: [] },
      { id: "s-cancel", area: 0, mode: "e2e", enabled: true, state: "default", viewports: ["desktop", "mobile"], description: "cancel button visible", assertion: { kind: "visible", testId: "cancel-btn" }, tags: [] }
    ]
  })
});

// ── the Full Drill run ───────────────────────────────────────────────────
console.log("running Full Drill (2 pages x 2 viewports)...");
const { run } = await jpost(DRILL, "/api/runs", { pageIds: ["chat", "build"], viewports: ["desktop", "mobile"] });
console.log(`run ${run.id}: ${run.pages.length} checks, ${run.findings.length} findings, evidence=${JSON.stringify(run.evidence)}`);

assert(run.pages.length === 6, "6 checks executed (3 steps x 2 viewports)");
assert(run.evidence?.video === "video.webm", "run-level video recorded");
assert(run.evidence?.steps === "steps.json", "steps manifest written");
assert(run.evidence?.index === "evidence.json", "evidence index written");
const mobileCancel = run.pages.find((p) => p.stepId === "s-cancel" && p.viewportId === "mobile");
assert(mobileCancel.status === "failed", "mobile cancel-button check failed (the fixture's real CSS bug)");
const desktopCancel = run.pages.find((p) => p.stepId === "s-cancel" && p.viewportId === "desktop");
assert(desktopCancel.status === "completed", "desktop cancel-button check passed");
const finding = run.findings.find((f) => f.kind === "step-fail" && f.stepId === "s-cancel");
assert(!!finding, "failing check pooled as a finding");
assert(finding.evidence?.screenshot === "fail-build--s-cancel--mobile.png", "finding carries its failure screenshot pointer");
assert(finding.evidence?.trace === "trace-build--s-cancel--mobile.zip", "finding carries its trace pointer");
assert(Number.isFinite(finding.evidence?.videoMs), "finding carries its video offset");

// ── on-disk evidence ─────────────────────────────────────────────────────
const evRoot = path.join(HOME, "drill", "evidence");
const evDir = readdirSync(evRoot).map((k) => path.join(evRoot, k, run.id)).find((p) => existsSync(p));
assert(!!evDir, "evidence dir exists");
console.log(`evidence dir: ${evDir}`);
for (const f of readdirSync(evDir).sort()) console.log(`  ${f}  ${statSync(path.join(evDir, f)).size} bytes`);
const video = readFileSync(path.join(evDir, "video.webm"));
assert(video.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), "video.webm has EBML magic");
assert(video.length > 20000, `video.webm is substantial (${video.length} bytes)`);
const steps = JSON.parse(readFileSync(path.join(evDir, "steps.json"), "utf8"));
assert(steps.length === 6, "steps.json has 6 rows");
assert(steps.every((r) => r.startMs >= 0 && r.endMs >= r.startMs), "steps.json offsets are sane");
assert(steps.every((r, i) => i === 0 || r.startMs >= steps[i - 1].startMs), "steps.json offsets are time-ordered");
const index = JSON.parse(readFileSync(path.join(evDir, "evidence.json"), "utf8"));
assert(index.items.filter((i) => i.kind === "step").length === 6, "evidence.json indexes all 6 checks");
assert(index.items.find((i) => i.kind === "video")?.sha256?.length === 64, "video row carries sha256");
assert(readdirSync(evDir).filter((f) => f.startsWith("trace-")).length === 6, "6 trace chunks on disk");
assert(existsSync(path.join(evDir, "fail-build--s-cancel--mobile.png")), "failure screenshot on disk");

// ── report + card links through the real kanban ──────────────────────────
const triage = await fetch(`${DRILL}/api/runs/${run.id}/findings/${finding.id}`, {
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed" })
});
assert(triage.ok, "finding confirmed");
const dispatch = await jpost(DRILL, `/api/runs/${run.id}/dispatch`, {});
const cardId = dispatch.card?.id ?? dispatch.run?.findings?.find((f) => f.card)?.card?.id;
assert(!!cardId, "dispatch minted a real kanban card");
const cardDetail = await (await fetch(`${KANBAN}/cards/${cardId}`)).json();
assert(cardDetail.card.videoUrl === `${DRILL}/api/runs/${run.id}/evidence-file/video.webm`, "card.videoUrl points at the run video");
assert(cardDetail.card.description.includes(`/api/runs/${run.id}/evidence-file/fail-build--s-cancel--mobile.png`), "card description links the failure screenshot");
assert(/video @\d+s: .*video\.webm#t=\d+/.test(cardDetail.card.description), "card description deep-links the video at the failure offset");
assert(cardDetail.links?.video?.kind === "href", "kanban resolves the video link");

// ── the report serves its evidence over confined routes ──────────────────
const idxRes = await fetch(`${DRILL}/api/runs/${run.id}/evidence-index`);
assert(idxRes.ok && (await idxRes.json()).steps.length === 6, "evidence-index route serves the manifest");
const ranged = await fetch(`${DRILL}/api/runs/${run.id}/evidence-file/video.webm`, { headers: { range: "bytes=0-1023" } });
assert(ranged.status === 206, "video serves with Range support (scrub/deep-link ready)");
const traceRes = await fetch(`${DRILL}/api/runs/${run.id}/evidence-file/${finding.evidence.trace}`);
assert(traceRes.status === 200 && traceRes.headers.get("content-type") === "application/zip", "trace chunk downloads as zip");

// ── Playwright: the video actually PLAYS + the UI links into evidence ────
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  // 1) The webm plays: load it in a real chromium video element and confirm
  //    playback advances.
  await page.setContent(`<video id="v" src="${DRILL}/api/runs/${run.id}/evidence-file/video.webm" muted autoplay></video>`);
  const advanced = await page.evaluate(() => new Promise((resolve) => {
    const v = document.getElementById("v");
    const t0 = Date.now();
    const tick = () => {
      if (v.currentTime > 0.2) return resolve({ ok: true, currentTime: v.currentTime });
      if (Date.now() - t0 > 8000) return resolve({ ok: false, currentTime: v.currentTime, error: v.error?.message });
      requestAnimationFrame(tick);
    };
    v.addEventListener("error", () => resolve({ ok: false, error: v.error?.message }));
    tick();
  }));
  assert(advanced.ok, `video PLAYS in chromium (currentTime ${advanced.currentTime?.toFixed?.(2)}s)`);

  // 2) The drill run report links into the evidence: Run & results view shows
  //    the video player, chapter buttons, and the finding's evidence links.
  //    (?view=results&run=<id> is the App's own deep-link contract.)
  const ui = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await ui.goto(`${DRILL}/?view=results&run=${run.id}`, { waitUntil: "domcontentloaded" });
  await ui.locator("video").waitFor({ timeout: 15000 });
  assert(await ui.locator("video").count() === 1, "run report renders the video player");
  assert(await ui.getByRole("button", { name: /s-cancel @/ }).count() > 0, "chapter buttons carry step offsets");
  await ui.locator(".dr-finding").first().waitFor({ timeout: 10000 });
  assert(await ui.locator(`a[href*="evidence-file/fail-build--s-cancel--mobile.png"]`).count() > 0 ||
         await ui.locator(`img[src*="evidence-file/fail-build--s-cancel--mobile.png"]`).count() > 0,
    "finding links its failure screenshot in the report");
  assert(await ui.locator(`a[href*="video.webm#t="]`).count() > 0, "report deep-links the video at check offsets");
  await ui.screenshot({ path: path.join(OUT, "drill-run-report.png"), fullPage: true });

  // 3) The kanban card detail shows the linkified evidence links. The SPA has
  //    no hash routing — open the card through the board's own Open action.
  const cardPage = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await cardPage.goto(KANBAN, { waitUntil: "domcontentloaded" });
  const cardFront = cardPage.locator(".card", { hasText: "Drill fix: build" }).first();
  await cardFront.waitFor({ timeout: 15000 });
  await cardFront.getByRole("button", { name: "Open" }).click();
  await cardPage.locator(".detail-desc").waitFor({ timeout: 10000 });
  assert(await cardPage.locator(`.detail-desc a[href*="evidence-file"]`).count() >= 2, "card description renders evidence links as anchors");
  await cardPage.screenshot({ path: path.join(OUT, "kanban-fix-card.png"), fullPage: true });
} finally {
  await browser.close();
}

console.log(`\nartifacts kept in ${OUT} (evidence: ${evDir})`);
console.log("DRILL-EVIDENCE-ACCEPTANCE OK");
for (const c of kids) c.kill("SIGTERM");
stub.close();
setTimeout(() => process.exit(0), 1500);
