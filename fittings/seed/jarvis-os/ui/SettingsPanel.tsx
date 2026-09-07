// Jarvis HUD settings — a small unobtrusive gear + popover. Three settings live
// here: HUD color (see ./hud-color.ts for the derivation), the per-state orb
// colours (listening / thinking / speaking — see ./core-colors.ts), and Orb
// mode (Phase 3 — shrinks the same persistent HUD into a draggable corner orb
// over the rest of Garrison; see ./orb-settings.ts and JarvisPersistentFrame.tsx
// for the shell-side half). No save button: every change flows straight to
// the parent's onChange* callbacks, which persist it (debounced) via
// /api/hud-settings.

import { useEffect, useRef, useState } from "react";
import { DEFAULT_HUD_COLOR, isValidHudColor } from "./hud-color";
import {
  CORE_STATE_KEYS,
  CORE_STATE_LABEL,
  DEFAULT_STATE_COLORS,
  THEMES,
  THEME_KEYS,
  activeTheme,
  isDefaultStateColors,
  isValidStateColor,
  type CoreStateKey,
  type StateColors,
  type ThemeKey,
} from "./core-colors";
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
  stateColors,
  onStateColorChange,
  onStateColorsReset,
  onThemeChange,
  orbMode,
  onOrbModeChange,
  orbCorner,
  onOrbCornerChange,
}: {
  color: string;
  onChange: (hex: string) => void;
  stateColors: StateColors;
  onStateColorChange: (state: CoreStateKey, hex: string) => void;
  onStateColorsReset: () => void;
  onThemeChange: (theme: ThemeKey) => void;
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
  const theme = activeTheme(swatch, stateColors);

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

          {/* One click that moves the chrome AND all three orb states. The
              chrome swatch alone cannot do this: it writes CSS variables, and
              the orb is a WebGL canvas that reads none of them. */}
          <div className="jarvis-settings-row">
            <span className="jarvis-settings-label">tema</span>
            <div className="jarvis-settings-themes" role="group" aria-label="Tema de cores">
              {THEME_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`jarvis-settings-theme${theme === key ? " is-active" : ""}`}
                  onClick={() => onThemeChange(key)}
                  aria-pressed={theme === key}
                  title={
                    key === "garrison"
                      ? "As cores do Garrison — verde sage e latão, para o HUD assentar dentro da app"
                      : "As cores originais do Jarvis"
                  }
                >
                  <span
                    className="jarvis-settings-theme-dot"
                    style={{ background: THEMES[key].states.listening }}
                    aria-hidden
                  />
                  <span
                    className="jarvis-settings-theme-dot"
                    style={{ background: THEMES[key].states.thinking }}
                    aria-hidden
                  />
                  {THEMES[key].label}
                </button>
              ))}
            </div>
          </div>

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

          {/* Orb colour per state. One swatch each so the three headline states
              stay tellable apart at a glance — which is the whole point of the
              orb changing colour at all. */}
          <div className="jarvis-settings-head jarvis-settings-subhead">cor do orbe</div>
          {CORE_STATE_KEYS.map((state) => (
            <label className="jarvis-settings-row" key={state} htmlFor={`jarvis-core-color-${state}`}>
              <span className="jarvis-settings-label">{CORE_STATE_LABEL[state]}</span>
              <input
                id={`jarvis-core-color-${state}`}
                type="color"
                className="jarvis-settings-swatch"
                value={isValidStateColor(stateColors[state]) ? stateColors[state] : DEFAULT_STATE_COLORS[state]}
                onChange={(e) => onStateColorChange(state, e.target.value)}
              />
            </label>
          ))}
          {!isDefaultStateColors(stateColors) && (
            <button className="jarvis-settings-reset" onClick={onStateColorsReset}>
              repor cores do orbe
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
