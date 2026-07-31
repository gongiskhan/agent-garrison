// Render ONE evidence panel: a clean file / API-response / server-log / output
// viewer, shown as a still — NEVER a terminal, NEVER typing, NEVER a shell
// prompt. The whole point: a human (or a website visitor) sees the *result* that
// proves the change, with the proving line highlighted and annotated — not a
// screen recording of someone typing commands.
//
// Every content source is read/run OFF-CAMERA; only the captured output is
// displayed. `command` runs once here (its stdout becomes the panel); it never
// appears being typed. This also makes the panel a real FUNCTIONAL assert: if a
// `highlight` match string is given, the captured content must actually contain
// it or the beat fails honestly (red bar, run flagged) — the same "two layers of
// truth" the browser segment enforces.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { exec } from './util.mjs';
import { evidenceKindMeta, evidencePanelHtml, renderHtmlToPng } from './render.mjs';

// Strip ANSI/VT escape sequences so a captured .ansi / coloured CLI output
// renders as clean text on the panel (colour codes read as garbage otherwise).
function stripAnsi(s) {
  return String(s)
    .replace(/\x1b[@-_][0-?]*[ -/]*[@-~]/g, '') // CSI/OSC/etc.
    .replace(/\x1b[=>]/g, '')
    .replace(/\r/g, '');
}

// Trim a trailing run of blank lines, cap line length so one runaway line can't
// blow out the layout, and normalise tabs' visual width is handled in CSS.
function cleanLines(text) {
  const lines = stripAnsi(text).replace(/\s+$/g, '').split('\n').map((l) => l.replace(/\s+$/g, ''));
  return lines.map((l) => (l.length > 200 ? l.slice(0, 197) + '…' : l));
}

function looksJson(s) {
  const t = s.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

// An unreadable source must fail THIS beat honestly (red panel, run flagged), not
// throw and abort the whole recording. Returns a content object whose `error`
// marks the beat failed and whose text is shown in the panel body.
function readErrorContent(seg, label, e) {
  const msg = `could not read ${label}: ${e && (e.code || e.message) || e}`;
  return {
    text: msg, kind: seg.kind || 'text', source: seg.source || label,
    lineNumbers: false, startLineNo: 1, absoluteNumbers: false, error: msg,
  };
}

// Resolve the segment's content source into { text, kind, source, lineNumbers,
// startLineNo, error? }. Exactly one source is expected; precedence file >
// command > logFile > text.
async function loadContent(seg, ctx) {
  const cwd = seg.cwd || ctx.cwd || process.cwd();
  const resolve = (p) => (path.isAbsolute(p) ? p : path.join(cwd, p));

  if (seg.file) {
    let text;
    try { text = readFileSync(resolve(seg.file), 'utf8'); }
    catch (e) { return readErrorContent(seg, seg.file, e); }
    let startLineNo = 1;
    let lines = text.split('\n');
    if (Array.isArray(seg.lineRange) && seg.lineRange.length === 2) {
      const [a, b] = seg.lineRange;
      startLineNo = Math.max(1, a);
      lines = lines.slice(a - 1, b);
    }
    if (seg.grep) lines = lines.filter((l) => l.includes(seg.grep));
    return {
      text: lines.join('\n'), kind: seg.kind || 'file',
      source: seg.source || seg.file, lineNumbers: seg.lineNumbers ?? true,
      startLineNo, absoluteNumbers: !seg.grep,
    };
  }

  if (seg.command) {
    const r = await exec('bash', ['-lc', seg.command], { cwd, timeoutMs: seg.timeoutMs || 60000 });
    let out = (r.stdout && r.stdout.trim()) ? r.stdout : (r.stderr || '');
    const asJson = seg.json === true || (seg.json !== false && looksJson(out));
    let kind = seg.kind || (asJson ? 'json' : 'output');
    if (asJson) { try { out = JSON.stringify(JSON.parse(out.trim()), null, 2); } catch {} }
    return {
      text: out, kind,
      source: seg.source || defaultSourceForCommand(seg.command),
      lineNumbers: seg.lineNumbers ?? false,
      startLineNo: 1, absoluteNumbers: false, exitCode: r.code,
    };
  }

  if (seg.logFile) {
    let text;
    try { text = readFileSync(resolve(seg.logFile), 'utf8'); }
    catch (e) { return readErrorContent(seg, seg.logFile, e); }
    let lines = text.split('\n');
    if (seg.grep) lines = lines.filter((l) => l.includes(seg.grep));
    const tail = seg.logTail ?? 40;
    if (lines.length > tail) lines = lines.slice(-tail);
    return {
      text: lines.join('\n'), kind: seg.kind || 'log',
      source: seg.source || path.basename(seg.logFile),
      lineNumbers: seg.lineNumbers ?? false, startLineNo: 1, absoluteNumbers: false,
    };
  }

  return {
    text: String(seg.text || ''), kind: seg.kind || 'text',
    source: seg.source || '', lineNumbers: seg.lineNumbers ?? false,
    startLineNo: 1, absoluteNumbers: false,
  };
}

function defaultSourceForCommand(cmd) {
  // A human-friendly provenance label, never the raw command with a prompt.
  const m = /https?:\/\/[^\s'"]+/.exec(cmd);
  if (m) {
    try { const u = new URL(m[0]); return `${/-X\s*POST|--data|-d\b/.test(cmd) ? 'POST' : 'GET'} ${u.pathname}${u.search}`; }
    catch { /* fall through */ }
  }
  return 'output';
}

// Normalise the highlight spec into { match, lines:Set<number>, note }.
function parseHighlight(h) {
  if (h == null) return { match: null, lines: null, note: '' };
  if (typeof h === 'string') return { match: h, lines: null, note: '' };
  const lines = h.lines ? new Set(h.lines) : (h.line != null ? new Set([h.line]) : null);
  return { match: h.match || null, lines, note: h.note || '' };
}

// Choose which lines to show (a window centred on the proof when content is long)
// and build the row model: code rows + one annotation row beneath the first
// highlighted line. Returns { rows, startLineNo, matched }.
function buildRows(content, hl, maxRows) {
  const raw = cleanLines(content.text);
  const numbered = raw.map((text, i) => ({
    n: content.absoluteNumbers ? content.startLineNo + i : i + 1,
    text,
  }));

  const isHl = (row) => {
    if (hl.lines && hl.lines.has(row.n)) return true;
    if (hl.match && row.text.includes(hl.match)) return true;
    return false;
  };
  const matched = hl.match ? numbered.some((r) => r.text.includes(hl.match)) : (hl.lines ? true : null);
  let firstHlIdx = numbered.findIndex(isHl);

  // Window long content around the proof (or head for files, tail already applied
  // for logs). Reserve one slot for the annotation note row.
  const budget = Math.max(6, maxRows - (hl.note ? 1 : 0));
  let slice = numbered;
  if (numbered.length > budget) {
    if (firstHlIdx >= 0) {
      let start = Math.max(0, firstHlIdx - Math.floor(budget / 2));
      start = Math.min(start, Math.max(0, numbered.length - budget));
      slice = numbered.slice(start, start + budget);
    } else {
      slice = numbered.slice(0, budget);
    }
  }

  const rows = [];
  let notePlaced = false;
  for (const row of slice) {
    const hit = isHl(row);
    rows.push({ type: 'code', n: content.lineNumbers ? row.n : null, text: row.text, hl: hit });
    if (hit && hl.note && !notePlaced) { rows.push({ type: 'note', text: hl.note }); notePlaced = true; }
  }
  return { rows, matched };
}

// Public: produce { png, result } for one evidence segment. record.mjs turns the
// png into a held still clip (pngToClip) — no VHS, no capture, no typing.
export async function recordEvidenceSegment(seg, ctx) {
  const { workDir, video } = ctx;
  const content = await loadContent(seg, ctx);
  const hl = parseHighlight(seg.highlight);

  // Rows + windowing. Body height mirrors the CSS box in evidencePanelHtml
  // (frame top/bottom pad + card header + body pad) so we never overflow.
  const barH = 110;
  const bodyPx = video.height - 34 - (barH + 26) - 51 - 28;
  const maxRows = Math.max(6, Math.floor(bodyPx / 28));
  const { rows, matched } = buildRows(content, hl, maxRows);

  // Functional truth is judged on what the panel ACTUALLY shows — buildRows'
  // `matched` runs over the SAME ANSI-stripped, windowed, truncated lines that get
  // rendered and highlighted — so the pass/flag verdict can never disagree with
  // the visible evidence. A required `match` absent from the displayed content
  // (including empty or unreadable content) fails honestly (red panel, run
  // flagged). A read error is a hard fail. An expectFailure panel intentionally
  // shows a negative and flags the run like a browser expected-failure (ok:false,
  // but not an *unexpected* failure).
  const readError = !!content.error;
  const proofMissing = hl.match != null && matched === false;
  const fail = !!seg.expectFailure || proofMissing || readError;
  const ok = seg.expectFailure ? false : (!proofMissing && !readError);
  const err = readError ? content.error
    : proofMissing ? `proof "${hl.match}" not shown in ${content.source || 'evidence'}`
    : null;

  const meta = evidenceKindMeta(content.kind);
  const model = {
    kind: content.kind,
    badge: seg.badge || (fail ? 'ERROR' : meta.badge),
    source: content.source,
    cmdChip: seg.cmdVisible && seg.command ? seg.command : null,
    lineNumbers: content.lineNumbers,
    rows,
    caption: seg.caption || '',
    fail,
    accent: seg.accent || null,
  };
  const html = evidencePanelHtml(model, { width: video.width, height: video.height });
  const png = await renderHtmlToPng(html, {
    workDir, width: video.width, height: video.height, name: `evidence-${seg.id}`,
  });
  return { png, result: { id: seg.id, ok, expectFailure: !!seg.expectFailure, err } };
}
