import { chromium } from "playwright";
const url = process.argv[2] || "http://127.0.0.1:8089/";
const out = process.argv[3] || "/tmp/board.png";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1100 } });
await p.goto(url, { waitUntil: "networkidle", timeout: 45000 });
await p.waitForTimeout(2500);
await p.screenshot({ path: out, fullPage: false });
// Report what the exec badges actually contain, so the check is not "it looked fine".
const badges = await p.$$eval(".chip.exec", (els) =>
  els.map((e) => ({
    cls: e.className,
    k: e.querySelector(".exec-k")?.textContent,
    v: e.querySelector(".exec-v")?.textContent,
    title: e.getAttribute("title")
  }))
);
console.log(JSON.stringify(badges.slice(0, 24), null, 1));
console.log("total exec badges:", badges.length);
await b.close();
