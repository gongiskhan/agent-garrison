"use client";

// ---------------------------------------------------------------------------
// Report reveal overlay — renders a markdown deliverable inside the HUD (no app
// switch, stays cinematic). Animates out from the core. Esc or the × closes it
// (HUD owns the Esc handling). Uses `marked` so code fences / file-trees and
// tables render properly (same renderer as the transcript).
// ---------------------------------------------------------------------------

import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });
function mdToHtml(md: string): string {
  try { return marked.parse(md || "", { async: false }) as string; } catch { return md; }
}

// Obsidian vault name (folder basename) — the obsidian:// URI needs the exact
// name. Client-side, so NEXT_PUBLIC_ (inlined at build). Unset = the "open in
// Obsidian" deep link is hidden.
const OBSIDIAN_VAULT = process.env.NEXT_PUBLIC_OBSIDIAN_VAULT ?? "";

export default function ReportOverlay({
  report,
  onClose,
  action,
}: {
  report: { path: string; content: string };
  onClose: () => void;
  /** optional header action (e.g. the transcript's reset button) */
  action?: { label: string; onClick: () => void };
}) {
  const title = report.path.split("/").pop()?.replace(/\.md$/, "") ?? report.path;
  // synthetic docs (e.g. the voice transcript) aren't vault notes — no deep link
  const isVaultNote = report.path.endsWith(".md");
  const obsidianHref = `obsidian://open?vault=${encodeURIComponent(OBSIDIAN_VAULT)}&file=${encodeURIComponent(report.path.replace(/\.md$/, ""))}`;
  return (
    <div className="report-overlay" onClick={onClose}>
      <div className="report-panel" onClick={(e) => e.stopPropagation()}>
        <div className="report-head">
          <span className="report-title">{title}</span>
          <span className="report-path">{report.path}</span>
          {isVaultNote && OBSIDIAN_VAULT && (
            <a className="report-obsidian" href={obsidianHref}>
              open in Obsidian ↗
            </a>
          )}
          {action && (
            <button className="report-obsidian report-action" onClick={action.onClick}>
              {action.label}
            </button>
          )}
          <button className="report-close" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>
        <div className="report-body" dangerouslySetInnerHTML={{ __html: mdToHtml(report.content) }} />
      </div>
    </div>
  );
}
