import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOARD = "http://127.0.0.1:27089";
const CARD_ID = "01KXMWJ11Y5CC38F0NJ0K6SGT1";
const TITLE = "Implement a medium-sized JavaScript TTL cache package";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VISION = path.join(HERE, "vision");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
page.setDefaultTimeout(180_000);

try {
  const response = await page.request.get(`${BOARD}/cards/${CARD_ID}`);
  const document = await response.json();
  if (!response.ok()) throw new Error(`card lookup failed: ${response.status()} ${JSON.stringify(document)}`);
  const { card, links, events = [] } = document;
  if (card.list !== "done" || card.status !== "ok") {
    throw new Error(`expected successful Done card, got ${card.list}/${card.status}`);
  }
  const evidence = links.evidence ?? [];
  const evidenceReport = evidence.find((item) => item.name === "evidence.md" && item.exists !== false);
  if (!evidenceReport) {
    throw new Error(`non-empty evidence.md is not linked: ${JSON.stringify(evidence)}`);
  }
  const gates = links.gates ?? [];
  const expectedGateNext = {
    "gate-status.plan.json": "implement",
    "gate-status.implement.json": "review",
    "gate-status.review.json": "test",
    "gate-status.test.json": "done"
  };
  const phaseGates = gates.filter((gate) => path.basename(gate.path ?? "") in expectedGateNext);
  if (phaseGates.length !== 4 || phaseGates.some((item) => item.exists === false)) {
    throw new Error(`expected all four per-phase gates: ${JSON.stringify(gates)}`);
  }
  const gateNext = {};
  for (const gate of phaseGates) {
    const name = path.basename(gate.path ?? "");
    const expectedNext = expectedGateNext[name];
    const gateResponse = await page.request.get(`${BOARD}${gate.url}`);
    const gateBody = await gateResponse.json();
    if (!gateResponse.ok() || gateBody.next_phase !== expectedNext) {
      throw new Error(`${name} must declare ${expectedNext}: ${gateResponse.status()} ${JSON.stringify(gateBody)}`);
    }
    gateNext[name] = gateBody.next_phase;
  }
  const evidenceResponse = await page.request.get(`${BOARD}${evidenceReport.url}`);
  const evidenceText = await evidenceResponse.text();
  if (!evidenceResponse.ok()
    || !evidenceText.trim()
    || !/(npm test|node --test)/i.test(evidenceText)
    || !/(14\s*\/\s*14|14[^\n]*pass)/i.test(evidenceText)) {
    throw new Error(`evidence.md lacks the executed 14/14 test proof: ${evidenceResponse.status()} ${evidenceText.slice(0, 1000)}`);
  }
  const routes = events.filter((event) => event.kind === "routed" && event.route).map((event) => event.route);
  const expected = [
    ["plan", "agent-sdk", "claude-sonnet-4-6", "medium"],
    ["implement", "claude-code", "claude-fable-5", "high"],
    ["review", "codex", "gpt-5.6-sol", "xhigh"],
    ["test", "claude-code", "haiku", "low"]
  ];
  for (const [phase, runtime, model, effort] of expected) {
    if (!routes.some((route) => route.phase === phase
      && route.runtime === runtime
      && route.model === model
      && route.effort === effort
      && route.effortApplied === true)) {
      throw new Error(`missing applied route ${phase}/${runtime}/${model}/${effort}: ${JSON.stringify(routes)}`);
    }
  }

  await page.goto(BOARD, { waitUntil: "domcontentloaded" });
  const doneColumn = page.locator("section.list").filter({
    has: page.locator(".lname-text", { hasText: /^Done$/ })
  });
  const cardNode = doneColumn.locator(".card").filter({
    has: page.locator(".title", { hasText: TITLE })
  });
  await cardNode.waitFor();
  await page.screenshot({ path: path.join(VISION, "34-final-done-board.png"), fullPage: true });

  await cardNode.getByRole("button", { name: "Open", exact: true }).click();
  const detail = page.locator(".sheet");
  await detail.waitFor();
  await page.screenshot({ path: path.join(VISION, "35-final-done-detail.png"), fullPage: true });

  const evidenceButton = detail.getByRole("button", { name: /evidence\.md/i });
  await evidenceButton.scrollIntoViewIfNeeded();
  await evidenceButton.click();
  const evidenceDialog = page.getByRole("dialog", { name: "evidence.md" });
  await evidenceDialog.waitFor();
  await evidenceDialog.locator(".art-view").filter({ hasNotText: /^\(empty\)$/ }).waitFor();
  await page.screenshot({ path: path.join(VISION, "36-final-evidence-open.png"), fullPage: true });

  console.log(JSON.stringify({
    action: "Assert and capture the completed mixed-runtime card",
    card: {
      id: card.id,
      list: card.list,
      status: card.status,
      iterations: card.iterations,
      runId: card.runId,
      lastRoute: card.lastRoute
    },
    routes: expected.map(([phase, runtime, model, effort]) => ({ phase, runtime, model, effort, effortApplied: true })),
    gates: gateNext,
    additionalGateArtifacts: gates
      .filter((gate) => !(path.basename(gate.path ?? "") in expectedGateNext))
      .map((gate) => path.basename(gate.path ?? gate.ref ?? "")),
    evidence: {
      name: evidenceReport.name,
      path: evidenceReport.path,
      exists: evidenceReport.exists,
      recordsTestCommand: true,
      records14Of14: true
    }
  }, null, 2));
} finally {
  await browser.close();
}
