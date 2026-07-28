// AUTO-COPIED by Drill into the target app repo at tests/drills/support/
// drill-judge.ts on first graduation. A qualitative-judgment helper (Q3) for
// steps a deterministic assertion cannot express (citation quality,
// generative-output judgment, canvas rendering) — routes through the same
// Model Router the automations engine's vision resolution uses, so it needs
// no model/effort pin of its own. Unlike a deterministic emitted assertion,
// a drillJudge() call DOES make a model call every run — that is inherent to
// judgment steps, not a graduation defect.
import type { Page } from "@playwright/test";

export async function drillJudge(page: Page, question: string): Promise<boolean> {
  const base = process.env.GARRISON_BASE_URL || "http://127.0.0.1:7777";
  const tokenPath =
    process.env.GARRISON_INTERNAL_TOKEN_PATH ||
    `${process.env.GARRISON_HOME || `${process.env.HOME}/.garrison`}/internal-token`;
  let token = "";
  try {
    const fs = await import("node:fs/promises");
    token = (await fs.readFile(tokenPath, "utf8")).trim();
  } catch {
    // No token file (standalone run outside a Garrison-managed machine) —
    // the request below will 403 with a clear error rather than hang.
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const res = await fetch(`${base}/api/automations/vision`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-garrison-internal": token },
    body: JSON.stringify({
      mode: "judge",
      observation: { url: page.url(), title: await page.title(), bodyText: bodyText.slice(0, 4000) },
      step: { description: question }
    })
  });
  if (!res.ok) {
    throw new Error(`drillJudge: vision endpoint ${res.status} — is Garrison running at ${base}?`);
  }
  const json = (await res.json()) as { result?: { passed?: boolean; reasoning?: string } };
  return json.result?.passed === true;
}
