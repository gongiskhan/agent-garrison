import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("http://127.0.0.1:8083", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(1500);
await p.locator(".wc-rsh-entry", { hasText: "CSG work" }).first().click();
await p.waitForSelector('[data-testid="remote-shell-pane"] .xterm-screen', { timeout: 30000 });
for (let i = 0; i < 20; i++) {
  await p.waitForTimeout(3000);
  const s = await p.evaluate(() => {
    const d = document.querySelector(".wc-wb-delegate");
    const turns = [...d.querySelectorAll(".cc-turn")];
    const last = turns[turns.length - 1];
    const assistants = [...(last?.querySelectorAll(".cc-assistant") ?? [])];
    return {
      working: !!d.querySelector(".cc-working-dots"),
      state: document.querySelector(".wc-workbench")?.dataset?.state,
      assistantCount: assistants.length,
      lastAssistant: (assistants[assistants.length - 1]?.textContent ?? "").trim().slice(0, 120),
      hasCode: !!last?.querySelector("pre code"),
    };
  });
  console.log(JSON.stringify(s));
  if (!s.working && s.assistantCount > 0) break;
}
await b.close();
