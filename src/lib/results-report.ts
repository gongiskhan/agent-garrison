import type { MediaRef, ReportStep, RunRecord, RunListingRow } from "./results-store";

// The report renderer. PURE - record in, HTML string out, no filesystem, no
// clock - so the whole page is testable and so re-rendering on every append is
// cheap enough to do on the write path.
//
// One static page per run: all CSS inline, no client framework, no external
// asset. The palette and idiom are lifted from the drill fitting's
// ui/styles.css (warm cream paper, sage-green + brass accents, SHARP corners,
// Source Serif 4 titles, JetBrains Mono metadata, no emoji) so a reported run
// reads as native to Drill rather than as a pasted-in prototype.
//
// Media is referenced ROOT-relative (/results/<id>/media/<name>), never as an
// absolute machine-local URL: the browser is almost never on the Garrison box,
// and a localhost URL is both unreachable and mixed content over the tailnet.

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function attr(value: unknown): string {
  return esc(value).replace(/\r?\n/g, " ");
}

const PALETTE = `
  --paper:#fbf8f1; --paper-2:#f4ede0; --paper-3:#ece2cc;
  --ink:#18211c; --ink-2:#2a342e; --mute:#66695f; --mute-2:#7d8077;
  --sage:#2f4a3a; --sage-2:#3d6249; --sage-soft:#eaf1e7;
  --brass:#b4862a; --brass-2:#d8a82e;
  --rule:#d6cdba; --rule-2:#c4b89f;
  --alarm:#9b362d; --alarm-soft:#f7eae6;
  --warn:#b07215; --warn-soft:#f6ecd0; --warn-ink:#8a5a10;
  --sans:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --serif:"Source Serif 4",Georgia,"Times New Roman",serif;
  --mono:"JetBrains Mono",ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;
`;

const BASE_CSS = `
:root{color-scheme:light;${PALETTE}}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
img,video,table,pre{max-width:100%}
a{color:var(--sage-2)}
.wrap{max-width:920px;margin:0 auto;padding:20px 16px 64px}
.kicker{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}
h1{font-family:var(--serif);font-size:26px;line-height:1.25;margin:6px 0 10px;font-weight:600}
h2{font-family:var(--serif);font-size:18px;margin:28px 0 10px;font-weight:600}
.meta{font-family:var(--mono);font-size:12px;color:var(--mute);display:flex;flex-wrap:wrap;gap:6px 18px;margin:10px 0 0}
.meta b{color:var(--ink-2);font-weight:500}
.rule{border:0;border-top:1px solid var(--rule);margin:18px 0}
.lede{color:var(--ink-2);margin:8px 0 0;max-width:62ch}
.badge{display:inline-block;font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:3px 8px;border:1px solid var(--rule-2);background:var(--paper-2);color:var(--ink-2)}
.tag{display:inline-block;font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:2px 6px;border:1px solid var(--rule);color:var(--mute);margin-right:4px}
`;

// The origin banner is the single most load-bearing element on the page: a
// self-declared report must be impossible to mistake for an executed drill.
// Reported gets the amber warning treatment plus a sentence saying so in
// words, not just a colour a reader has to know how to decode.
const ORIGIN_CSS = `
.origin{border:1px solid var(--rule-2);border-left-width:6px;padding:12px 14px;margin:0 0 18px;display:flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline}
.origin .who{font-family:var(--mono);font-size:12px;letter-spacing:.16em;text-transform:uppercase;font-weight:600}
.origin .what{color:var(--ink-2);font-size:13px}
.origin.reported{background:var(--warn-soft);border-color:var(--warn);color:var(--warn-ink)}
.origin.reported .who{color:var(--warn-ink)}
.origin.executed{background:var(--sage-soft);border-color:var(--sage)}
.origin.executed .who{color:var(--sage)}
`;

const STEP_CSS = `
.steps{list-style:none;margin:0;padding:0}
.step{border:1px solid var(--rule);border-left-width:5px;background:var(--paper-2);margin:0 0 10px;padding:12px 14px}
.step.pass{border-left-color:var(--sage)}
.step.fail{border-left-color:var(--alarm);background:var(--alarm-soft)}
.step.skipped{border-left-color:var(--rule-2)}
.step.info{border-left-color:var(--brass)}
.step-head{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline}
.step-n{font-family:var(--mono);font-size:12px;color:var(--mute-2);min-width:2.2em}
.step-name{font-weight:600;font-size:15px;flex:1 1 220px;overflow-wrap:anywhere}
.step-at{font-family:var(--mono);font-size:11px;color:var(--mute-2)}
.st{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:2px 7px;border:1px solid currentColor}
.st.pass{color:var(--sage)}
.st.fail{color:var(--alarm)}
.st.skipped{color:var(--mute)}
.st.info{color:var(--warn-ink)}
.step-desc{margin:8px 0 0;color:var(--ink-2);overflow-wrap:anywhere}
.step-body{margin-top:10px}
pre.logs{background:var(--paper-3);border:1px solid var(--rule);padding:10px;overflow-x:auto;font-family:var(--mono);font-size:12px;margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.notes{background:var(--paper-3);border:1px solid var(--rule);padding:10px;font-family:var(--mono);font-size:12px;margin:8px 0 0;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.shots{display:flex;flex-wrap:wrap;gap:10px;margin:10px 0 0}
.shot{border:1px solid var(--rule-2);background:var(--paper);padding:4px;max-width:100%}
.shot img{display:block;max-width:320px;width:100%;height:auto}
.cap{font-family:var(--mono);font-size:10px;color:var(--mute-2);padding:4px 2px 0;overflow-wrap:anywhere}
.vid{margin:10px 0 0}
.vid video{width:100%;background:#000;border:1px solid var(--rule-2)}
.vid .cap{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center}
.files{margin:8px 0 0;font-family:var(--mono);font-size:12px}
.empty{color:var(--mute);font-style:italic;padding:12px 0}
`;

const SUMMARY_CSS = `
.tally{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 0}
.tally .cell{border:1px solid var(--rule);background:var(--paper-2);padding:6px 12px;font-family:var(--mono);font-size:12px}
.tally .cell b{font-size:16px;font-weight:600;margin-right:6px}
.tally .cell.fail{border-color:var(--alarm);color:var(--alarm)}
.tally .cell.pass{border-color:var(--sage);color:var(--sage)}
.conclusion{border:1px solid var(--rule);border-left-width:5px;border-left-color:var(--brass);background:var(--paper-2);padding:12px 14px;margin:14px 0 0;overflow-wrap:anywhere}
`;

const LIST_CSS = `
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);border-bottom-color:var(--rule-2)}
td.mono{font-family:var(--mono);font-size:12px;color:var(--mute-2);white-space:nowrap}
tr.reported td:first-child{border-left:4px solid var(--warn);padding-left:8px}
tr.reported td:first-child a{color:var(--warn-ink)}
tr.executed td:first-child{border-left:4px solid var(--sage);padding-left:8px}
`;

function page(title: string, css: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${css}</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>
`;
}

function fmtDuration(startedAt: string, endedAt: string | null): string {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "-";
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function mediaUrl(runId: string, name: string): string {
  return `/results/${encodeURIComponent(runId)}/media/${encodeURIComponent(name)}`;
}

function renderMedia(runId: string, media: MediaRef[]): string {
  if (!media.length) return "";
  const images = media.filter((m) => m.kind === "image");
  const videos = media.filter((m) => m.kind === "video");
  const files = media.filter((m) => m.kind === "file");
  const parts: string[] = [];
  if (images.length) {
    parts.push(
      `<div class="shots">${images
        .map(
          (m) =>
            `<figure class="shot"><a href="${attr(mediaUrl(runId, m.name))}" target="_blank" rel="noreferrer"><img src="${attr(
              mediaUrl(runId, m.name)
            )}" alt="${attr(m.caption ?? m.name)}" loading="lazy"></a><figcaption class="cap">${esc(
              m.caption ?? m.name
            )}</figcaption></figure>`
        )
        .join("")}</div>`
    );
  }
  for (const m of videos) {
    // Keyframes are extracted on ingest and rendered as images above, so the
    // report shows visual evidence before anyone presses play. The first one
    // also becomes the poster, so the player is a frame of the run rather than
    // a black rectangle.
    const poster = m.keyframes?.[0] ? ` poster="${attr(mediaUrl(runId, m.keyframes[0]))}"` : "";
    parts.push(
      `<div class="vid"><video controls preload="metadata" playsinline${poster} src="${attr(
        mediaUrl(runId, m.name)
      )}"></video><div class="cap"><span class="tag">video</span><span>${esc(m.caption ?? m.name)}</span>${
        m.keyframeNote ? `<span>(${esc(m.keyframeNote)})</span>` : ""
      }</div></div>`
    );
  }
  if (files.length) {
    parts.push(
      `<div class="files">${files
        .map((m) => `<div><a href="${attr(mediaUrl(runId, m.name))}">${esc(m.caption ?? m.name)}</a></div>`)
        .join("")}</div>`
    );
  }
  return parts.join("\n");
}

function renderStep(runId: string, step: ReportStep): string {
  const notes =
    step.notes === undefined || step.notes === null
      ? ""
      : `<div class="notes">${esc(typeof step.notes === "string" ? step.notes : JSON.stringify(step.notes, null, 2))}</div>`;
  const desc = step.description && step.description !== step.name ? `<p class="step-desc">${esc(step.description)}</p>` : "";
  const tags = step.tags?.length ? step.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("") : "";
  return `<li class="step ${esc(step.status)}">
  <div class="step-head">
    <span class="step-n">${esc(step.n)}.</span>
    <span class="step-name">${esc(step.name)}</span>
    <span class="st ${esc(step.status)}">${esc(step.status)}</span>
    <span class="step-at">${esc(step.at)}</span>
  </div>
  ${tags ? `<div>${tags}</div>` : ""}
  ${desc}
  <div class="step-body">
    ${step.logs ? `<pre class="logs">${esc(step.logs)}</pre>` : ""}
    ${notes}
    ${renderMedia(runId, step.media)}
  </div>
</li>`;
}

export function renderReportHtml(record: RunRecord): string {
  const reported = record.origin !== "executed";
  const originBlock = `<div class="origin ${reported ? "reported" : "executed"}">
  <span class="who">${reported ? "Reported evidence" : "Executed drill run"}</span>
  <span class="what">${
    reported
      ? "Self-declared by the reporting session through the Results MCP. Nothing here was executed or checked by Drill."
      : "Produced by an actual Drill run."
  }</span>
</div>`;

  const meta = [
    ["run", record.id],
    ["session", record.source.session ?? "-"],
    ["via", record.source.tool ?? "-"],
    ["project", record.source.project ?? record.source.cwd ?? "-"],
    ["started", record.startedAt],
    ["ended", record.endedAt ?? "in progress"],
    ["duration", fmtDuration(record.startedAt, record.endedAt)]
  ]
    .map(([k, v]) => `<span><b>${esc(k)}</b> ${esc(v)}</span>`)
    .join("");

  // pass and fail always show - "0 fail" is the headline of a clean run. The
  // other two only appear when they happened; a standing "0 info" is noise
  // competing with the counts that carry the verdict.
  const tally = ([
    ["pass", record.summary.pass, true],
    ["fail", record.summary.fail, true],
    ["skipped", record.summary.skipped, false],
    ["info", record.summary.info, false]
  ] as Array<[string, number, boolean]>)
    .filter(([, v, always]) => always || v > 0)
    .map(([k, v]) => `<span class="cell ${esc(k)}"><b>${esc(v)}</b>${esc(k)}</span>`)
    .join("");

  const steps = record.steps.length
    ? `<ul class="steps">${record.steps.map((s) => renderStep(record.id, s)).join("\n")}</ul>`
    : `<p class="empty">No steps reported yet.</p>`;

  const body = `${originBlock}
<p class="kicker">Garrison results &middot; ${esc(record.status)}</p>
<h1>${esc(record.title)}</h1>
<div class="meta">${meta}</div>
<div class="tally">${tally}</div>
${record.conclusion ? `<div class="conclusion">${esc(record.conclusion)}</div>` : ""}
<hr class="rule">
<h2>Steps</h2>
${steps}
${record.media.length ? `<h2>Run evidence</h2>${renderMedia(record.id, record.media)}` : ""}
<hr class="rule">
<p class="kicker"><a href="/results">All results</a> &middot; <a href="/api/results/${encodeURIComponent(
    record.id
  )}">JSON</a></p>`;

  return page(`${record.title} - Garrison results`, BASE_CSS + ORIGIN_CSS + STEP_CSS + SUMMARY_CSS, body);
}

export function renderIndexHtml(rows: RunListingRow[]): string {
  const body = `<p class="kicker">Garrison</p>
<h1>Results</h1>
<p class="lede">Every run reported to the Results MCP or written by an executed drill. Newest first.</p>
<hr class="rule">
${
  rows.length
    ? `<table><thead><tr><th>Run</th><th>Origin</th><th>Status</th><th>Steps</th><th>Started</th></tr></thead><tbody>${rows
        .map(
          (r) => `<tr class="${esc(r.origin)}">
  <td><a href="/results/${encodeURIComponent(r.id)}">${esc(r.title)}</a></td>
  <td class="mono">${esc(r.origin)}</td>
  <td class="mono">${esc(r.status)}${r.summary.fail ? ` (${esc(r.summary.fail)} fail)` : ""}</td>
  <td class="mono">${esc(r.steps)}</td>
  <td class="mono">${esc(r.startedAt)}</td>
</tr>`
        )
        .join("")}</tbody></table>`
    : `<p class="empty">No results reported yet.</p>`
}`;
  return page("Results - Garrison", BASE_CSS + LIST_CSS, body);
}
