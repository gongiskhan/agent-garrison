"use client";

// ---------------------------------------------------------------------------
// Diff reveal overlay — renders a `git diff HEAD` patch the way a code review
// reads: one clearly-labelled block PER FILE (path + a +adds/−dels tally) and
// colour-coded lines (green add / red delete / dim context / cobalt hunk head).
// Reuses the report-overlay shell (backdrop + panel + head) for a consistent
// HUD look; the body is a custom diff renderer, not markdown.
// ---------------------------------------------------------------------------

type LineKind = "add" | "del" | "hunk" | "ctx";
interface DiffLine { kind: LineKind; text: string; }
interface DiffFile { path: string; adds: number; dels: number; lines: DiffLine[]; }

// Parse a unified `git diff` patch into per-file blocks. The path comes from the
// `diff --git a/… b/…` header; pure-metadata lines (index/---/+++/mode/rename)
// are dropped since the path is already the block's title.
function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git")) {
      const m = raw.match(/ b\/(.+)$/);
      cur = { path: m ? m[1] : raw.replace(/^diff --git /, ""), adds: 0, dels: 0, lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (
      raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ") ||
      raw.startsWith("new file") || raw.startsWith("deleted file") ||
      raw.startsWith("old mode") || raw.startsWith("new mode") ||
      raw.startsWith("similarity ") || raw.startsWith("rename ") ||
      raw.startsWith("Binary files")
    ) continue;
    if (raw.startsWith("@@")) { cur.lines.push({ kind: "hunk", text: raw }); continue; }
    if (raw.startsWith("+")) { cur.adds++; cur.lines.push({ kind: "add", text: raw.slice(1) }); continue; }
    if (raw.startsWith("-")) { cur.dels++; cur.lines.push({ kind: "del", text: raw.slice(1) }); continue; }
    cur.lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  return files;
}

const GUTTER: Record<LineKind, string> = { add: "+", del: "−", hunk: "›", ctx: " " };

export default function DiffOverlay({
  title,
  patch,
  truncated,
  onClose,
}: {
  title: string;
  patch: string;
  truncated?: boolean;
  onClose: () => void;
}) {
  const files = parseDiff(patch);
  const totalAdds = files.reduce((n, f) => n + f.adds, 0);
  const totalDels = files.reduce((n, f) => n + f.dels, 0);
  return (
    <div className="report-overlay" onClick={onClose}>
      <div className="report-panel diff-panel" onClick={(e) => e.stopPropagation()}>
        <div className="report-head">
          <span className="report-title">diff</span>
          <span className="report-path">{title}</span>
          <span className="diff-total">
            <span className="diff-total-add">+{totalAdds}</span>{" "}
            <span className="diff-total-del">−{totalDels}</span>
          </span>
          <button className="report-close" onClick={onClose} aria-label="close">✕</button>
        </div>
        <div className="report-body diff-body">
          {files.length === 0 ? (
            <div className="diff-empty">Sem alterações em ficheiros versionados (só ficheiros novos por adicionar).</div>
          ) : (
            files.map((f, i) => (
              <div key={i} className="diff-file">
                <div className="diff-file-head">
                  <span className="diff-file-path">{f.path}</span>
                  <span className="diff-file-stat">
                    <span className="diff-total-add">+{f.adds}</span>{" "}
                    <span className="diff-total-del">−{f.dels}</span>
                  </span>
                </div>
                <div className="diff-lines">
                  {f.lines.map((l, j) => (
                    <div key={j} className={`diff-line diff-${l.kind}`}>
                      <span className="diff-gutter">{GUTTER[l.kind]}</span>
                      <span className="diff-code">{l.text || " "}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
          {truncated && <div className="diff-trunc">diff truncado — abre o ficheiro para ver o resto.</div>}
        </div>
      </div>
    </div>
  );
}
