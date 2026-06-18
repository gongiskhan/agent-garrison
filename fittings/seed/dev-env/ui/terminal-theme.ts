// Terminal colour theme for the Dev Env xterm panes. Three modes — light,
// dark, and system (follow the OS via prefers-color-scheme). The mode is a
// single global preference (localStorage), shared across every pane: switching
// re-themes all live terminals at once. Only the TERMINALS are themed here;
// the surrounding chrome keeps its own (light) palette.
//
// Imperative-update, not React state: TerminalPane builds its xterm in an
// effect keyed on ptyId and we don't want to remount a live PTY on a theme
// change, so panes subscribe() and re-apply term.options.theme in place.

import type { ITheme } from "@xterm/xterm";

export type TermMode = "light" | "dark" | "system";

const LS_KEY = "garrison.devenv.termTheme";
// Same-tab cross-component sync event, shared by name (no import coupling) with
// @garrison/claude-chat's chat-theme.ts so the chat's light/dark/system toggle
// and this terminal toggle stay in lock-step within one tab — localStorage's
// `storage` event does not fire in the originating tab.
const SYNC_EVENT = "garrison:devenv-theme";

// Dark palette is byte-for-byte the previous hardcoded one, so "dark" looks
// exactly like the terminal always did. ANSI colours are left to xterm's
// defaults (tuned for dark backgrounds).
const DARK: ITheme = {
  background: "#0e0e0e",
  foreground: "#e5e5e5",
  cursor: "#e5e5e5",
  cursorAccent: "#0e0e0e",
  selectionBackground: "#3b3b3b"
};

// Light palette is tuned to sit on the cream chrome (--bg #fbf8f1). xterm's
// default ANSI colours are dark-background colours and wash out on a light
// surface, so light ships a full, contrast-checked ANSI ramp.
const LIGHT: ITheme = {
  background: "#fbf8f1",
  foreground: "#22271f",
  cursor: "#2f4a3a",
  cursorAccent: "#fbf8f1",
  selectionBackground: "#dfe4d6",
  black: "#22271f",
  red: "#9b362d",
  green: "#3d6249",
  yellow: "#a8761f",
  blue: "#2f5d86",
  magenta: "#83458c",
  cyan: "#2f7d80",
  white: "#5f6356",
  brightBlack: "#66695f",
  brightRed: "#b8463b",
  brightGreen: "#4a7558",
  brightYellow: "#b4862a",
  brightBlue: "#3a6f9e",
  brightMagenta: "#9a559f",
  brightCyan: "#3a9296",
  brightWhite: "#22271f"
};

const PALETTES: Record<"light" | "dark", ITheme> = { light: LIGHT, dark: DARK };

const listeners = new Set<() => void>();

const mql =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

function readMode(): TermMode {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {}
  // Default to dark: preserve the terminal's historical appearance until the
  // user opts into light or system.
  return "dark";
}

let mode: TermMode = readMode();

export function getMode(): TermMode {
  return mode;
}

// The concrete palette in effect, resolving "system" against the OS setting.
export function resolvedScheme(): "light" | "dark" {
  if (mode === "system") return mql?.matches ? "dark" : "light";
  return mode;
}

export function currentTheme(): ITheme {
  return PALETTES[resolvedScheme()];
}

// Keep the chrome's --term-bg (used for pane padding / viewport background)
// matched to the active terminal background, so there's no mismatched border
// around the xterm canvas.
function syncRootVar(): void {
  try {
    document.documentElement.style.setProperty("--term-bg", String(currentTheme().background));
  } catch {}
}

function notify(): void {
  syncRootVar();
  for (const fn of listeners) {
    try { fn(); } catch {}
  }
}

export function setMode(next: TermMode): void {
  if (next !== "light" && next !== "dark" && next !== "system") return;
  mode = next;
  try { localStorage.setItem(LS_KEY, next); } catch {}
  // Notify the chat's theme module (and any other sibling) in this same tab.
  try { window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: next })); } catch {}
  notify();
}

// Subscribe to theme changes (mode switch, or OS change while in system mode).
// Returns an unsubscribe fn.
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// When following the OS, react to OS appearance changes live.
if (mql) {
  const onChange = () => { if (mode === "system") notify(); };
  if (typeof mql.addEventListener === "function") mql.addEventListener("change", onChange);
  else if (typeof mql.addListener === "function") mql.addListener(onChange); // older Safari
}

// When the chat's theme toggle (or another tab) writes the shared key, re-read
// and re-theme the terminals so terminal + chat never diverge.
if (typeof window !== "undefined") {
  const reread = () => {
    const next = readMode();
    if (next !== mode) { mode = next; notify(); }
  };
  window.addEventListener("storage", (e) => { if (e.key === LS_KEY) reread(); });
  window.addEventListener(SYNC_EVENT, reread as EventListener);
}

// Apply the initial --term-bg at module load so first paint matches.
syncRootVar();
