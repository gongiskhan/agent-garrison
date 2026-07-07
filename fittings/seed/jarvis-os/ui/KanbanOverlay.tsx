"use client";

// Full-screen board reveal — opens the kanban board focused on a card INSIDE the
// HUD (iframe) so following a Tasks-panel link never leaves the voice HUD. Reuses
// the report-overlay shell (backdrop + panel + head). A header link still opens
// the board in a real tab for anyone who wants it.
export default function KanbanOverlay({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div className="report-overlay" onClick={onClose}>
      <div className="report-panel report-panel-wide" onClick={(e) => e.stopPropagation()}>
        <div className="report-head">
          <span className="report-title">kanban</span>
          <a className="report-obsidian" href={url} target="_blank" rel="noreferrer">abrir noutra aba ↗</a>
          <button className="report-close" onClick={onClose} aria-label="close">✕</button>
        </div>
        <iframe
          src={url}
          title="kanban"
          allow="clipboard-read; clipboard-write"
          style={{ width: "100%", height: "82vh", border: 0, display: "block", background: "var(--paper)" }}
        />
      </div>
    </div>
  );
}
