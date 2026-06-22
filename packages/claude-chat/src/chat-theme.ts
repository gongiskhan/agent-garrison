// Light / dark / system theming for the rich Claude chat surface.
//
// This module is intentionally SELF-CONTAINED — @garrison/claude-chat is a
// shared package (web-channel + dev-env both depend on it) so it cannot import
// the dev-env-only terminal-theme.ts. Instead it mirrors that module's exact
// pattern (TermMode tri-state, getMode/setMode/resolvedScheme, subscribe via a
// listener Set, an mql for the system case) AND — crucially — reads/writes the
// SAME localStorage key ("garrison.devenv.termTheme"). So inside dev-env the
// terminal toggle and the chat toggle are one shared preference: flipping one
// re-themes the other, because both persist to and read from the same key.
//
// Default behaviour is OPT-IN per host. The chat only applies a theme when the
// host passes themeMode !== undefined to ClaudeChat (web-channel passes nothing
// and therefore keeps its current fixed dark palette untouched). When dev-env
// opts in, the stored value (or its absence) decides light/dark/system exactly
// as the terminal does.

export type ChatThemeMode = "light" | "dark" | "system";

// Same key the dev-env terminal theme uses, so terminal + chat share one mode.
const LS_KEY = "garrison.devenv.termTheme";
// Same-tab cross-component sync event. localStorage.setItem does NOT fire a
// `storage` event in the originating tab, so the terminal toggle and this chat
// toggle additionally dispatch this window CustomEvent (a name-only contract,
// no import coupling between the two packages) and listen for each other's.
const SYNC_EVENT = "garrison:devenv-theme";

const listeners = new Set<() => void>();

const mql =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

function read(): ChatThemeMode {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {}
  // Match terminal-theme.ts: default to dark until the user opts into light or
  // system. (web-channel never enables theming, so its look is unchanged.)
  return "dark";
}

let mode: ChatThemeMode = read();

export function getChatMode(): ChatThemeMode {
  return mode;
}

export function resolvedChatScheme(): "light" | "dark" {
  if (mode === "system") return mql?.matches ? "dark" : "light";
  return mode;
}

function notify(): void {
  for (const fn of listeners) {
    try { fn(); } catch {}
  }
}

export function setChatMode(next: ChatThemeMode): void {
  if (next !== "light" && next !== "dark" && next !== "system") return;
  mode = next;
  try { localStorage.setItem(LS_KEY, next); } catch {}
  // Tell any sibling theme component (the dev-env terminal toggle) in this same
  // tab so it re-themes live too.
  try { window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: next })); } catch {}
  notify();
}

// Subscribe to mode changes (this tab's toggle, the terminal toggle writing the
// shared key in another component, or an OS appearance change while in system
// mode). Returns an unsubscribe fn. Also listens to `storage` events so the
// terminal toggle in a sibling React tree re-themes the chat live.
export function subscribeChatTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (mql) {
  const onChange = () => { if (mode === "system") notify(); };
  if (typeof mql.addEventListener === "function") mql.addEventListener("change", onChange);
  else if (typeof (mql as any).addListener === "function") (mql as any).addListener(onChange);
}

if (typeof window !== "undefined") {
  const reread = () => {
    const next = read();
    if (next !== mode) { mode = next; notify(); }
  };
  // Other-tab change (native event) + same-tab sibling toggle (custom event).
  window.addEventListener("storage", (e) => { if (e.key === LS_KEY) reread(); });
  window.addEventListener(SYNC_EVENT, reread as EventListener);
}
