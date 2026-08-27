// Render styled HTML to PNG via playwright-cli (screenshots are sandboxed to the
// work dir). Used for title/outro cards and evidence panels.
import { pw, htmlDataUrl } from './util.mjs';
import { FONT, CAPTION } from './style.mjs';
import path from 'node:path';

// esc for embedding plain text into HTML.
function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function titleCardHtml(title, subtitle, { width, height, accent = '#14b8a6', flag = false }) {
  const bg = flag
    ? 'linear-gradient(135deg,#3f0d0d,#1a0606)'
    : 'linear-gradient(135deg,#0f172a,#134e4a)';
  const badge = flag
    ? `<div style="margin-bottom:28px;padding:8px 18px;border:2px solid #ef4444;border-radius:999px;color:#fca5a5;font-size:20px;font-weight:700;letter-spacing:.08em">RUN FLAGGED &middot; CONTAINS FAILURES</div>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${width}px;height:${height}px;background:${bg};color:#fff;
      font-family:${FONT};display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
    h1{font-size:62px;margin:0 48px;line-height:1.1}
    p{font-size:27px;color:${flag ? '#fca5a5' : '#5eead4'};margin-top:18px}
  </style></head><body>${badge}<h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</body></html>`;
}

// Mono stack for evidence panels (file / API response / log / output). System
// fonts only, same rationale as FONT — resolves identically in headless Chromium.
const MONO = `ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", "Roboto Mono", monospace`;

// Accent + badge per evidence kind. The badge is a small static label in the
// panel header — provenance, NOT a shell prompt. Never a caret, never typed.
const EVIDENCE_KINDS = {
  json:   { badge: 'API RESPONSE', accent: '#2dd4bf' },
  output: { badge: 'OUTPUT',       accent: '#38bdf8' },
  log:    { badge: 'SERVER LOG',   accent: '#fbbf24' },
  file:   { badge: 'FILE',         accent: '#a5b4fc' },
  code:   { badge: 'SOURCE',       accent: '#a5b4fc' },
  text:   { badge: 'EVIDENCE',     accent: '#94a3b8' },
};
export function evidenceKindMeta(kind) {
  return EVIDENCE_KINDS[kind] || EVIDENCE_KINDS.text;
}

// A full-frame "evidence panel": a clean file / API-response / log / output
// viewer rendered as ONE still (no VHS, no terminal, no typing). The content was
// captured OFF-camera; here we only DISPLAY it — a titled document window whose
// proving line(s) are highlighted and annotated with a human-readable note, over
// a caption bar identical to the rest of the video. This is the evidence a human
// (or a website visitor) can actually read, not a screen recording of a shell.
//
//   model = { kind, badge, source, cmdChip, lineNumbers, startLineNo,
//             rows:[ {type:'code',n,text,hl} | {type:'note',text} ], caption, fail }
export function evidencePanelHtml(model, { width, height }) {
  const meta = evidenceKindMeta(model.kind);
  const accent = model.fail ? '#f87171' : (model.accent || meta.accent);
  const badge = model.badge || meta.badge;
  const barH = 110; // caption bar, matched to the terminal/title caption look

  const gutter = model.lineNumbers !== false;
  const rowsHtml = (model.rows || []).map((r) => {
    if (r.type === 'note') {
      // Annotation row directly beneath the proving line: an up-arrow that points
      // at it plus the human note, in the accent colour. Aligned to the content
      // column so it reads as "this line, right above, is the proof".
      const gut = gutter ? `<span class="ln"></span>` : '';
      return `<div class="row note">${gut}<span class="notetxt"><span class="arrow">&#8593;</span>${esc(r.text)}</span></div>`;
    }
    const gut = gutter ? `<span class="ln">${r.n != null ? r.n : ''}</span>` : '';
    return `<div class="row code${r.hl ? ' hl' : ''}">${gut}<span class="src">${esc(r.text) || '&nbsp;'}</span></div>`;
  }).join('');

  const cmdChip = model.cmdChip
    ? `<span class="cmd">${esc(model.cmdChip)}</span>` : '';
  const prefix = model.fail ? `<span style="color:${CAPTION.failText};font-weight:800">FAILED &mdash; </span>` : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}
    html,body{margin:0;width:${width}px;height:${height}px;background:#0b0e14;font-family:${FONT}}
    .frame{position:absolute;inset:0;padding:34px 40px ${barH + 26}px 40px}
    .card{height:100%;background:#0d1117;border:1px solid #232b39;border-radius:14px;
      box-shadow:0 24px 60px rgba(0,0,0,.5);overflow:hidden;display:flex;flex-direction:column}
    .head{display:flex;align-items:center;gap:16px;padding:15px 22px;background:#131a26;
      border-bottom:1px solid #232b39;flex:0 0 auto}
    .badge{font-size:14px;font-weight:800;letter-spacing:.12em;color:#0b0e14;background:${accent};
      padding:5px 11px;border-radius:6px;white-space:nowrap}
    .source{font-size:21px;font-weight:600;color:#e6edf6;font-family:${MONO};white-space:nowrap;
      overflow:hidden;text-overflow:ellipsis}
    .cmd{margin-left:auto;font-family:${MONO};font-size:15px;color:#8b98a9;background:#0b0e14;
      border:1px solid #232b39;border-radius:6px;padding:5px 10px;white-space:nowrap}
    .body{flex:1 1 auto;overflow:hidden;padding:14px 0;font-family:${MONO};font-size:19px;
      line-height:28px;tab-size:2;-moz-tab-size:2}
    .row{display:flex;align-items:flex-start;padding:0 22px 0 0;min-height:28px}
    .row.hl{background:${hexA(accent, 0.13)};box-shadow:inset 4px 0 0 ${accent}}
    .ln{flex:0 0 58px;text-align:right;padding-right:18px;color:#48536a;user-select:none}
    .row.hl .ln{color:${accent}}
    .src{white-space:pre;color:#d5dde8}
    .row.hl .src{color:#ffffff}
    .note .notetxt{color:${accent};font-weight:700;font-family:${FONT};font-size:18px;padding-left:2px;
      flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .note .arrow{display:inline-block;margin-right:9px;font-weight:800;transform:translateY(1px)}
    .bar{position:absolute;left:0;right:0;bottom:0;height:${barH}px;background:${CAPTION.bg};
      border-top:4px solid ${accent};display:flex;align-items:center;padding:0 ${CAPTION.padX}px}
    .bar .cap{font-size:${CAPTION.fontSize}px;font-weight:${CAPTION.weight};color:${CAPTION.fg};
      line-height:${CAPTION.lineHeight};letter-spacing:${CAPTION.letterSpacing};
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  </style></head><body>
    <div class="frame"><div class="card">
      <div class="head"><span class="badge">${esc(badge)}</span><span class="source">${esc(model.source || '')}</span>${cmdChip}</div>
      <div class="body">${rowsHtml}</div>
    </div></div>
    <div class="bar"><div class="cap">${prefix}${esc(model.caption || '')}</div></div>
  </body></html>`;
}

// #rrggbb + alpha -> rgba() string (design tokens above are hex).
function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Render an HTML string to a PNG inside the work dir. Returns the PNG path.
// Runs on the run's `render` lane — a throwaway browser on its OWN session so it
// never closes the recording lane (e.g. a kept-open `continue` session) and is
// torn down right after the shot rather than left for the next call to clear.
export async function renderHtmlToPng(html, { workDir, width, height, name }) {
  const file = `${name}.png`;
  const R = { lane: 'render' };
  // `open` self-heals any stale render session (it stops the existing one first).
  await pw(['open', htmlDataUrl(html)], workDir, R);
  await pw(['resize', String(width), String(height)], workDir, R);
  // settle layout/fonts
  await pw(['run-code', 'async page => { await page.waitForTimeout(150); return "ok"; }'], workDir, R);
  const r = await pw(['screenshot', `--filename=${file}`], workDir, R);
  await pw(['close'], workDir, R).catch(() => {});
  if (r.code !== 0) throw new Error(`screenshot failed: ${r.stderr || r.stdout}`);
  return path.join(workDir, file);
}
