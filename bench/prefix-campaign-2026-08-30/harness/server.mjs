#!/usr/bin/env node
// The review UI. Serves one page listing A..H, each with the eight behaviours
// from TASK.md as a fixed checklist and a free-text box, and appends whatever
// is submitted to ~/bench/review/verdicts.md.
//
// The page must not reveal which arm a label is. It reads only the label and
// the port, never the mapping, and the apps are served from directories named
// after the label.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const R = path.join(HOME, "bench", "review");
const VERDICTS = path.join(R, "verdicts.md");
const UI_PORT = Number(process.env.REVIEW_PORT || 3110);
const LABELS = "ABCDEFGH".split("");
const PORT_OF = (l) => 3101 + LABELS.indexOf(l);

const BEHAVIOURS = [
  "Create a todo with a title and an optional due date",
  "List todos, filterable by all / open / done",
  "Mark done and undo",
  "Delete",
  "Edit the title",
  "Persists across a server restart",
  "Overdue todos are visually distinct in the UI",
  "Tests covering create, complete and list filtering, passing",
];

if (!fs.existsSync(VERDICTS)) {
  fs.writeFileSync(VERDICTS, `# Verdicts\n\nOne section per label, appended as you submit. The key is in KEY.md.\n`);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function page(flash) {
  const cards = LABELS.map((l) => `
  <section class="card" id="card-${l}">
    <header><h2>${l}</h2><a class="open" href="http://localhost:${PORT_OF(l)}/" target="_blank" rel="noreferrer">open :${PORT_OF(l)}</a></header>
    <form method="POST" action="/submit">
      <input type="hidden" name="label" value="${l}">
      <ol class="behaviours">
        ${BEHAVIOURS.map((b, i) => `<li>
          <span class="btext">${esc(b)}</span>
          <span class="opts">
            <label><input type="radio" name="b${i}" value="yes"> yes</label>
            <label><input type="radio" name="b${i}" value="no"> no</label>
            <label><input type="radio" name="b${i}" value="partial"> partial</label>
          </span>
        </li>`).join("")}
      </ol>
      <label class="notes">Notes<textarea name="notes" rows="4" placeholder="anything worth recording about ${l}"></textarea></label>
      <button type="submit">Save ${l}</button>
    </form>
  </section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blind review</title><style>
:root{--bg:#12140f;--fg:#e8e6df;--dim:#9a9a90;--line:#2c2f26;--card:#191c15;--accent:#8fb573}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header.top{padding:20px 24px;border-bottom:1px solid var(--line)}
h1{margin:0;font-size:18px;font-weight:650}
p.sub{margin:6px 0 0;color:var(--dim);font-size:13px}
.flash{margin:12px 24px 0;padding:10px 12px;border:1px solid var(--accent);border-radius:8px;color:var(--accent);font-size:13px}
.grid{display:grid;gap:16px;padding:20px 24px 60px;grid-template-columns:repeat(auto-fill,minmax(340px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.card h2{margin:0;font-size:26px;font-weight:700;letter-spacing:.02em}
a.open{color:var(--accent);text-decoration:none;font-size:13px;border:1px solid var(--line);padding:4px 10px;border-radius:6px}
a.open:hover{border-color:var(--accent)}
ol.behaviours{margin:0 0 10px;padding-left:20px}
ol.behaviours li{margin-bottom:7px}
.btext{display:block;font-size:13px}
.opts{display:inline-flex;gap:10px;margin-top:2px}
.opts label{font-size:12px;color:var(--dim);display:inline-flex;gap:4px;align-items:center}
label.notes{display:block;font-size:13px;color:var(--dim)}
textarea{width:100%;margin-top:4px;background:#0e100b;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}
button{margin-top:10px;background:var(--accent);color:#12140f;border:0;border-radius:6px;padding:8px 16px;font-weight:650;cursor:pointer}
button:hover{filter:brightness(1.08)}
@media (prefers-color-scheme: light){:root{--bg:#f7f7f3;--fg:#1d1f19;--dim:#5f6257;--line:#dcdcd2;--card:#fff;--accent:#3f6b2c}
textarea{background:#fff}}
</style></head><body>
<header class="top"><h1>Blind review — A to H</h1>
<p class="sub">Eight builds of the same spec, labelled and shuffled. Open each, work the list, save. Answers append to <code>verdicts.md</code>. The key is in <code>KEY.md</code>.</p></header>
${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
<div class="grid">${cards}</div></body></html>`;
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/submit") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const label = form.get("label") ?? "?";
      const rows = BEHAVIOURS.map((b, i) => `| ${i + 1} | ${b} | ${form.get(`b${i}`) ?? ""} |`).join("\n");
      fs.appendFileSync(VERDICTS,
        `\n## ${label} — ${new Date().toISOString()}\n\n| # | behaviour | verdict |\n|---|---|---|\n${rows}\n\n` +
        `Notes:\n\n${(form.get("notes") ?? "").trim() || "_(none)_"}\n`);
      res.writeHead(303, { location: `/?saved=${encodeURIComponent(label)}#card-${label}` });
      res.end();
    });
    return;
  }
  const saved = new URL(req.url, "http://x").searchParams.get("saved");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page(saved ? `Saved ${saved} to verdicts.md.` : ""));
});
server.listen(UI_PORT, "127.0.0.1", () => console.log(`[review] http://localhost:${UI_PORT}`));
