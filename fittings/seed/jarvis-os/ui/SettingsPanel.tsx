// Jarvis HUD settings — a small unobtrusive gear + popover. Two settings live
// here: HUD color (see ./hud-color.ts for the derivation) and Orb mode
// (Phase 3 — shrinks the same persistent HUD into a draggable corner orb over
// the rest of Garrison; see ./orb-settings.ts and JarvisPersistentFrame.tsx
// for the shell-side half). No save button: every change flows straight to
// the parent's onChange* callbacks, which persist it (debounced) via
// /api/hud-settings.

import { useEffect, useRef, useState } from "react";
import { DEFAULT_HUD_COLOR, isValidHudColor } from "./hud-color";
import { ORB_CORNERS, type OrbCorner } from "./orb-settings";

const CORNER_LABEL: Record<OrbCorner, string> = {
  "top-left": "⌜",
  "top-right": "⌝",
  "bottom-left": "⌞",
  "bottom-right": "⌟",
};
const CORNER_TITLE: Record<OrbCorner, string> = {
  "top-left": "canto superior esquerdo",
  "top-right": "canto superior direito",
  "bottom-left": "canto inferior esquerdo",
  "bottom-right": "canto inferior direito",
};

export default function SettingsPanel({
  color,
  onChange,
  orbMode,
  onOrbModeChange,
  orbCorner,
  onOrbCornerChange,
}: {
  color: string;
  onChange: (hex: string) => void;
  orbMode: boolean;
  onOrbModeChange: (next: boolean) => void;
  orbCorner: OrbCorner;
  onOrbCornerChange: (next: OrbCorner) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape so the popover never has to be "fought"
  // shut — it isn't modal (no scrim), so a stray click elsewhere should
  // dismiss it like any lightweight menu.
  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const swatch = isValidHudColor(color) ? color : DEFAULT_HUD_COLOR;

  return (
    <div className="jarvis-settings" ref={rootRef}>
      <button
        className={`jarvis-settings-btn${open ? " is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Fechar definições" : "Definições do HUD"}
        title="Definições do HUD"
      >
        <span aria-hidden>⚙</span>
      </button>
      {open && (
        <div className="jarvis-settings-panel" role="dialog" aria-label="Definições do HUD">
          <div className="jarvis-settings-head">definições</div>
          <label className="jarvis-settings-row" htmlFor="jarvis-hud-color">
            <span className="jarvis-settings-label">cor do HUD</span>
            <input
              id="jarvis-hud-color"
              type="color"
              className="jarvis-settings-swatch"
              value={swatch}
              onChange={(e) => onChange(e.target.value)}
            />
          </label>
          {swatch.toLowerCase() !== DEFAULT_HUD_COLOR.toLowerCase() && (
            <button className="jarvis-settings-reset" onClick={() => onChange(DEFAULT_HUD_COLOR)}>
              repor cor por omissão
            </button>
          )}

          <div className="jarvis-settings-sep" role="separator" />

          <label className="jarvis-settings-row" htmlFor="jarvis-orb-mode">
            <span className="jarvis-settings-label">modo orbe</span>
            <button
              id="jarvis-orb-mode"
              type="button"
              className={`jarvis-settings-toggle${orbMode ? " is-on" : ""}`}
              role="switch"
              aria-checked={orbMode}
              onClick={() => onOrbModeChange(!orbMode)}
              title={orbMode ? "Voltar ao HUD completo noutras páginas" : "Encolher para um orbe flutuante noutras páginas"}
            >
              <span className="jarvis-settings-toggle-knob" />
            </button>
          </label>

          {orbMode && (
            <div className="jarvis-settings-corners" role="group" aria-label="Canto do orbe">
              {ORB_CORNERS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`jarvis-settings-corner${orbCorner === c ? " is-active" : ""}`}
                  onClick={() => onOrbCornerChange(c)}
                  aria-pressed={orbCorner === c}
                  title={CORNER_TITLE[c]}
                >
                  {CORNER_LABEL[c]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
