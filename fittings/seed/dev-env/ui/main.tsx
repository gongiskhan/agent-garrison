// Garrison Dev Env shell. One compact header (hamburger menu + tab strip +
// "+ Terminal"), one workspace per visited session: the Claude pane on top and
// a tiling deck of shell terminals below it on the left, the live browser pane
// on the right (desktop only). Terminals are opened on demand — the deck starts
// empty and each new terminal splits the last one, alternating stacked/side-by-
// side; every split is drag-resizable. Mobile collapses to a single full-screen
// pane with a Claude | Shell segmented toggle. Sessions are polled from GET
// /sessions every 3s — the single channel for status / dirty / PTY state.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { TerminalPane } from "./terminal-pane";
import { ChatPane } from "./chat-pane";

// Per-session claude-view preference (terminal | chat), with a global default.
// localStorage matches the existing split-ratio / show-all precedent; two
// browser tabs can legitimately view the same PTY differently.
const LS_CLAUDE_VIEW = "garrison.devenv.claudeView";
function readClaudeView(sessionId: string): "terminal" | "chat" {
  try {
    const per = localStorage.getItem(`${LS_CLAUDE_VIEW}.${sessionId}`);
    if (per === "terminal" || per === "chat") return per;
    const def = localStorage.getItem(LS_CLAUDE_VIEW);
    if (def === "chat") return "chat";
  } catch {}
  return "terminal";
}
function writeClaudeView(sessionId: string, v: "terminal" | "chat") {
  try { localStorage.setItem(`${LS_CLAUDE_VIEW}.${sessionId}`, v); } catch {}
}
import { BrowserPane, type WiredInfo } from "./browser-pane";
import { NewWorktreeDialog, StartSessionDialog, ConfirmDeleteDialog, SettingsDialog, Toast } from "./dialogs";
import { getMode, setMode, type TermMode } from "./terminal-theme";

// Light / Dark / System control for the terminal colour theme. Three-state
// segmented control in the header; the choice is a global preference and
// re-themes every live terminal at once (see terminal-theme.ts).
const THEME_OPTIONS: { mode: TermMode; label: string; icon: React.ReactNode }[] = [
  {
    mode: "light",
    label: "Light",
    icon: (
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <line x1="8" y1="1" x2="8" y2="2.8" /><line x1="8" y1="13.2" x2="8" y2="15" />
          <line x1="1" y1="8" x2="2.8" y2="8" /><line x1="13.2" y1="8" x2="15" y2="8" />
          <line x1="3.1" y1="3.1" x2="4.3" y2="4.3" /><line x1="11.7" y1="11.7" x2="12.9" y2="12.9" />
          <line x1="12.9" y1="3.1" x2="11.7" y2="4.3" /><line x1="4.3" y1="11.7" x2="3.1" y2="12.9" />
        </g>
      </svg>
    )
  },
  {
    mode: "dark",
    label: "Dark",
    icon: (
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" fill="currentColor" />
      </svg>
    )
  },
  {
    mode: "system",
    label: "System",
    icon: (
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="8.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <line x1="5.5" y1="13.5" x2="10.5" y2="13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    )
  }
];

function TermThemeToggle() {
  const [mode, setLocalMode] = useState<TermMode>(() => getMode());
  return (
    <div className="term-theme" role="group" aria-label="Terminal theme">
      {THEME_OPTIONS.map((opt) => (
        <button
          key={opt.mode}
          type="button"
          className={mode === opt.mode ? "active" : ""}
          aria-pressed={mode === opt.mode}
          title={`${opt.label} terminal theme`}
          aria-label={`${opt.label} terminal theme`}
          onClick={() => { setMode(opt.mode); setLocalMode(opt.mode); }}
        >
          {opt.icon}
        </button>
      ))}
    </div>
  );
}

interface PtySummary {
  id?: string;
  state: "running" | "exited" | "persisted" | "none";
  exitCode?: number | null;
  createdAt?: string;
  claudeAlive?: boolean;
}

// One shell terminal in a session's deck. `index` is the role index (shell → 1,
// shell-2 → 2, …) used for the label; `id` is the PTY id the TerminalPane wires.
interface TerminalSummary {
  id: string;
  role: string;
  index: number;
  state: "running" | "exited" | "persisted" | "none";
  exitCode?: number | null;
  createdAt?: string;
}

interface DevEnvSession {
  id: string;
  branch: string;
  worktreePath: string;
  projectName: string;
  projectPath: string;
  lastStatus: string;
  lastStatusAt: string;
  claudeSessionId: string | null;
  title: string | null;
  source: string;
  dirty: boolean | null;
  isWorktree: boolean;
  external: boolean;
  excluded?: boolean;
  claudeClosed: boolean;
  claudePty: PtySummary;
  terminals: TerminalSummary[];
}

const LS_SELECTED = "garrison.devenv.selected";
const LS_SPLIT_RATIO = "garrison.devenv.splitRatio";
const LS_CLAUDE_RATIO = "garrison.devenv.claudeRatio";
const LS_TERMTREE = "garrison.devenv.termtree";
const LS_SHOW_ALL = "garrison.devenv.showAll";
const POLL_MS = 3000;
const MOBILE_QUERY = "(max-width: 720px)";
const ACTIVE_WINDOW_MS = 90 * 60 * 1000;

// The state file is a ledger of every session the hooks ever saw, not a list
// of live ones. A tab is shown by default only when the session is plausibly
// active: a PTY exists here (running, exited, or parked for resume), hooks
// say it's working right now, or it fired any hook in the last 90 minutes.
// `waiting` is NOT inherently active — the server never decays it, so a
// days-old unanswered Notification would pin a tab forever; recency covers
// the live case. Same for worktree rows: adopted-but-untouched worktrees are
// exactly the ledger noise, and Dev-Env-created ones stay visible through
// their PTYs. Everything else hides behind the menu's Show-all toggle.
function isActiveSession(s: DevEnvSession): boolean {
  if (s.claudePty.state !== "none" || s.terminals.length > 0) return true;
  if (s.lastStatus === "working" || s.lastStatus === "starting") return true;
  const t = Date.parse(s.lastStatusAt || "");
  return Number.isFinite(t) && Date.now() - t < ACTIVE_WINDOW_MS;
}

function basename(p: string): string {
  const parts = (p || "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

// Label priority: explicit title; on a default/detached branch the folder
// name (projectName carries repo/subdir for hook-created rows); otherwise
// the worktree dir name for worktrees, else the branch name.
function tabLabel(s: DevEnvSession): string {
  const folder = s.projectName || basename(s.worktreePath) || s.id;
  let raw: string;
  if (s.title) raw = s.title;
  else if (!s.branch || s.branch === "main" || s.branch === "master" || s.branch === "detached") raw = folder;
  else if (s.isWorktree) raw = basename(s.worktreePath) || s.branch;
  else raw = s.branch;
  return raw.length > 30 ? raw.slice(0, 29) + "…" : raw;
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

function QuickPromptBar({
  sessionId,
  disabled,
  onSend
}: {
  sessionId: string;
  disabled: boolean;
  onSend: (sessionId: string, text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const ok = await onSend(sessionId, t);
    setBusy(false);
    if (ok) setText("");
  }

  return (
    <div className="quick-prompt">
      <input
        type="text"
        value={text}
        disabled={disabled || busy}
        placeholder="Send a prompt to Claude…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
      />
      <button type="button" className="btn" disabled={disabled || busy || !text.trim()} onClick={() => void send()}>
        Send
      </button>
    </div>
  );
}

function ClaudePaneOverlay({
  session,
  onEnsureClaude
}: {
  session: DevEnvSession;
  onEnsureClaude: (sessionId: string, resume: boolean) => void;
}) {
  const { claudePty, external, claudeSessionId } = session;

  if (claudePty.state === "running" && claudePty.claudeAlive === false) {
    return (
      <div className="pane-overlay">
        <p>claude exited — the shell underneath is still alive.</p>
        <button type="button" className="btn primary" onClick={() => onEnsureClaude(session.id, true)}>
          Restart claude
        </button>
      </div>
    );
  }
  if (claudePty.state === "running") return null;

  if (claudePty.state === "persisted") {
    return (
      <div className="pane-overlay">
        <p>Claude session persisted from a previous Dev Env run.</p>
        <button type="button" className="btn primary" onClick={() => onEnsureClaude(session.id, true)}>
          Resume (claude --continue)
        </button>
      </div>
    );
  }
  if (claudePty.state === "exited") {
    return (
      <div className="pane-overlay">
        <p>Terminal exited with code {claudePty.exitCode ?? "?"}.</p>
        <button type="button" className="btn primary" onClick={() => onEnsureClaude(session.id, true)}>
          Restart
        </button>
      </div>
    );
  }
  if (external) {
    return (
      <div className="pane-overlay">
        <p>Claude is running elsewhere for this directory (detected via hooks).</p>
        <p className="pane-overlay-warn">
          Take over starts a second claude here with <code>--continue</code>; if the
          external one is still running, both will be attached to the project.
        </p>
        <button type="button" className="btn primary" onClick={() => onEnsureClaude(session.id, true)}>
          Take over (claude --continue)
        </button>
      </div>
    );
  }
  return (
    <div className="pane-overlay">
      <p>No Claude terminal for this session yet.</p>
      <div className="pane-overlay-row">
        <button type="button" className="btn primary" onClick={() => onEnsureClaude(session.id, false)}>
          Start Claude
        </button>
        {claudeSessionId && (
          <button type="button" className="btn" onClick={() => onEnsureClaude(session.id, true)}>
            Resume (claude --continue)
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────── terminal tiling deck
// Shell terminals tile in a binary-space-partition tree. Each new terminal
// splits the most-recently-added leaf, alternating orientation: the first split
// is `col` (the new pane lands BELOW), the next `row` (BESIDE), and so on —
// "intercalate vertical with horizontal". Every split is drag-resizable.
type SplitDir = "row" | "col"; // row = side by side; col = stacked (one below the other)
type TermTree =
  | { t: "leaf"; id: string }
  | { t: "split"; dir: SplitDir; ratio: number; a: TermTree; b: TermTree };

function leafIds(node: TermTree | null): string[] {
  if (!node) return [];
  if (node.t === "leaf") return [node.id];
  return [...leafIds(node.a), ...leafIds(node.b)];
}

function lastLeafId(node: TermTree | null): string | null {
  if (!node) return null;
  if (node.t === "leaf") return node.id;
  return lastLeafId(node.b) ?? lastLeafId(node.a);
}

// Replace the leaf whose id === targetId with a split of [old, new].
function splitLeaf(node: TermTree, targetId: string, newId: string, dir: SplitDir): TermTree {
  if (node.t === "leaf") {
    if (node.id !== targetId) return node;
    return { t: "split", dir, ratio: 0.5, a: { t: "leaf", id: targetId }, b: { t: "leaf", id: newId } };
  }
  return { ...node, a: splitLeaf(node.a, targetId, newId, dir), b: splitLeaf(node.b, targetId, newId, dir) };
}

// Drop a leaf, collapsing its parent split into the surviving sibling.
function removeLeaf(node: TermTree, id: string): TermTree | null {
  if (node.t === "leaf") return node.id === id ? null : node;
  const a = removeLeaf(node.a, id);
  const b = removeLeaf(node.b, id);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
}

// `path` is a string of 'a'/'b' steps to the split node ("" = this node).
function setRatioAt(node: TermTree, path: string, ratio: number): TermTree {
  if (node.t !== "split") return node;
  if (path === "") return { ...node, ratio };
  const rest = path.slice(1);
  return path[0] === "a"
    ? { ...node, a: setRatioAt(node.a, rest, ratio) }
    : { ...node, b: setRatioAt(node.b, rest, ratio) };
}

// Sync the layout tree to the server's terminal set: prune gone leaves, then
// append new ones in order — each splitting the current last leaf, orientation
// alternating from the split count (first split `col`, then `row`, …).
function reconcileTree(tree: TermTree | null, serverIds: string[]): TermTree | null {
  let t = tree;
  const present = new Set(serverIds);
  for (const id of leafIds(t)) {
    if (!present.has(id) && t) t = removeLeaf(t, id);
  }
  const have = new Set(leafIds(t));
  for (const id of serverIds) {
    if (have.has(id)) continue;
    const n = have.size;
    if (n === 0 || t === null) {
      t = { t: "leaf", id };
    } else {
      const dir: SplitDir = (n - 1) % 2 === 0 ? "col" : "row";
      t = splitLeaf(t, lastLeafId(t)!, id, dir);
    }
    have.add(id);
  }
  return t;
}

function treesEqual(a: TermTree | null, b: TermTree | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.t !== b.t) return false;
  if (a.t === "leaf" && b.t === "leaf") return a.id === b.id;
  if (a.t === "split" && b.t === "split") {
    return a.dir === b.dir && a.ratio === b.ratio && treesEqual(a.a, b.a) && treesEqual(a.b, b.b);
  }
  return false;
}

function readTree(sessionId: string): TermTree | null {
  try {
    const raw = localStorage.getItem(`${LS_TERMTREE}.${sessionId}`);
    if (raw) return JSON.parse(raw) as TermTree;
  } catch {}
  return null;
}

function writeTree(sessionId: string, tree: TermTree | null) {
  try {
    if (tree) localStorage.setItem(`${LS_TERMTREE}.${sessionId}`, JSON.stringify(tree));
    else localStorage.removeItem(`${LS_TERMTREE}.${sessionId}`);
  } catch {}
}

// A draggable divider between the two children of a split. `dir` is the parent
// split's orientation: `row` → a vertical bar (col-resize); `col` → a
// horizontal bar (row-resize). The fraction is read off the parent element.
function SplitHandle({ dir, onResize, onCommit }: { dir: SplitDir; onResize: (r: number) => void; onCommit: () => void }) {
  const draggingRef = useRef(false);
  return (
    <div
      className={`term-divider ${dir}`}
      role="separator"
      aria-orientation={dir === "row" ? "vertical" : "horizontal"}
      title="Drag to resize"
      onPointerDown={(e) => {
        e.preventDefault();
        draggingRef.current = true;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
      }}
      onPointerMove={(e) => {
        if (!draggingRef.current) return;
        const container = e.currentTarget.parentElement;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const raw = dir === "row"
          ? (e.clientX - rect.left) / rect.width
          : (e.clientY - rect.top) / rect.height;
        onResize(Math.min(0.9, Math.max(0.1, raw)));
      }}
      onPointerUp={(e) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
        onCommit();
      }}
      onPointerCancel={(e) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
        onCommit();
      }}
    />
  );
}

function TermLeaf({
  term,
  active,
  onClose,
  onRestart
}: {
  term: TerminalSummary | undefined;
  active: boolean;
  onClose: (role: string) => void;
  onRestart: (role: string) => void;
}) {
  if (!term) {
    return (
      <div className="term-leaf">
        <div className="pane-body">
          <div className="pane-overlay"><p>Terminal closing…</p></div>
        </div>
      </div>
    );
  }
  const running = term.state === "running";
  return (
    <div className="term-leaf">
      <div className="pane-strip term-leaf-strip">
        <span>term {term.index}</span>
        <button
          type="button"
          className="pane-close"
          onClick={() => onClose(term.role)}
          title="Close terminal"
        >
          ×
        </button>
      </div>
      <div className="pane-body">
        {running ? (
          <TerminalPane key={term.id} ptyId={term.id} isActive={active} />
        ) : (
          <div className="pane-overlay">
            <p>Terminal exited{term.exitCode != null ? ` (code ${term.exitCode})` : ""}.</p>
            <div className="pane-overlay-row">
              <button type="button" className="btn primary" onClick={() => onRestart(term.role)}>Restart</button>
              <button type="button" className="btn" onClick={() => onClose(term.role)}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TermTreeView({
  node,
  path,
  active,
  termById,
  onClose,
  onRestart,
  onResize,
  onCommit
}: {
  node: TermTree;
  path: string;
  active: boolean;
  termById: Map<string, TerminalSummary>;
  onClose: (role: string) => void;
  onRestart: (role: string) => void;
  onResize: (path: string, r: number) => void;
  onCommit: () => void;
}) {
  if (node.t === "leaf") {
    return <TermLeaf term={termById.get(node.id)} active={active} onClose={onClose} onRestart={onRestart} />;
  }
  return (
    <div className={`term-split ${node.dir}`}>
      <div className="term-split-cell" style={{ flexGrow: node.ratio, flexBasis: 0, minWidth: 0, minHeight: 0 }}>
        <TermTreeView node={node.a} path={`${path}a`} active={active} termById={termById} onClose={onClose} onRestart={onRestart} onResize={onResize} onCommit={onCommit} />
      </div>
      <SplitHandle dir={node.dir} onResize={(r) => onResize(path, r)} onCommit={onCommit} />
      <div className="term-split-cell" style={{ flexGrow: 1 - node.ratio, flexBasis: 0, minWidth: 0, minHeight: 0 }}>
        <TermTreeView node={node.b} path={`${path}b`} active={active} termById={termById} onClose={onClose} onRestart={onRestart} onResize={onResize} onCommit={onCommit} />
      </div>
    </div>
  );
}

function SessionWorkspace({
  session,
  active,
  isMobile,
  mobilePane,
  splitRatio,
  browserPref,
  onDividerPointerDown,
  onDividerPointerMove,
  onDividerPointerUp,
  onWired,
  onEnsureClaude,
  onInstruct,
  onClosePty,
  onAddTerminal,
  onCloseTerminal,
  onRestartTerminal,
  onCloseBrowser,
  onPinBrowserOpen
}: {
  session: DevEnvSession;
  active: boolean;
  isMobile: boolean;
  mobilePane: "claude" | "shell";
  splitRatio: number;
  browserPref: "open" | "closed" | undefined;
  onDividerPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDividerPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDividerPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onWired: (info: WiredInfo) => void;
  onEnsureClaude: (sessionId: string, resume: boolean) => void;
  onInstruct: (sessionId: string, text: string) => Promise<boolean>;
  onClosePty: (sessionId: string, role: "claude") => void;
  onAddTerminal: (sessionId: string) => void;
  onCloseTerminal: (sessionId: string, role: string) => void;
  onRestartTerminal: (sessionId: string, role: string) => void;
  onCloseBrowser: (sessionId: string) => void;
  onPinBrowserOpen: (sessionId: string) => void;
}) {
  const claudeRunning = session.claudePty.state === "running";
  const claudeKey = `${session.claudePty.id ?? "none"}:${session.claudePty.createdAt ?? ""}`;
  const showClaude = !isMobile || mobilePane === "claude";
  const showDeck = !isMobile || mobilePane === "shell";

  const [claudeView, setClaudeViewState] = useState<"terminal" | "chat">(() => readClaudeView(session.id));
  const setClaudeView = useCallback(
    (v: "terminal" | "chat") => {
      setClaudeViewState(v);
      writeClaudeView(session.id, v);
    },
    [session.id]
  );

  // Tiling deck of shell terminals. The tree (structure + ratios) is a UI
  // concern persisted per session in localStorage; it is reconciled against the
  // server's terminal set on every poll so terminals opened/closed by another
  // client (or restored after a restart) tile in automatically.
  const termById = new Map(session.terminals.map((t) => [t.id, t]));
  const serverIds = session.terminals.map((t) => t.id);
  const idsKey = serverIds.join("|");
  const [tree, setTree] = useState<TermTree | null>(() => reconcileTree(readTree(session.id), serverIds));
  useEffect(() => {
    setTree((prev) => {
      const next = reconcileTree(prev, idsKey ? idsKey.split("|") : []);
      return treesEqual(prev, next) ? prev : next;
    });
  }, [idsKey]);
  useEffect(() => { writeTree(session.id, tree); }, [tree, session.id]);

  const resizeSplit = useCallback((path: string, r: number) => {
    setTree((prev) => (prev ? setRatioAt(prev, path, r) : prev));
  }, []);
  const commitTree = useCallback(() => {
    setTree((prev) => { writeTree(session.id, prev); return prev; });
  }, [session.id]);

  const hasTerminals = session.terminals.length > 0;
  // Mobile shows a single terminal (the newest) — side-by-side tiling is a
  // desktop affordance. Closing it falls back to the next newest.
  const mobileLeafId = lastLeafId(tree);

  // Claude pane / deck vertical split, drag-resizable. Stored globally so a new
  // tab inherits the last ratio.
  const colRef = useRef<HTMLDivElement | null>(null);
  const claudeDragRef = useRef(false);
  const [claudeRatio, setClaudeRatio] = useState<number>(() => {
    const v = Number(localStorage.getItem(LS_CLAUDE_RATIO));
    return Number.isFinite(v) && v > 0.15 && v < 0.85 ? v : 0.55;
  });

  // The browser pane only opens by default while an app.port is detected for
  // this cwd; "open"/"closed" prefs (menu Open browser / pane ×) override.
  // Hiding needs 3 consecutive misses so a dev-server restart (brief app.port
  // gap) or a flaky Tailscale fetch doesn't unmount the pane mid-use.
  const [hasAppPort, setHasAppPort] = useState(false);
  const missesRef = useRef(0);
  useEffect(() => {
    if (isMobile || !active || browserPref !== undefined) return;
    let cancelled = false;
    const check = async () => {
      let ok = false;
      try {
        const res = await fetch(`/app-port?cwd=${encodeURIComponent(session.worktreePath)}`);
        ok = res.ok;
      } catch {}
      if (cancelled) return;
      if (ok) {
        missesRef.current = 0;
        setHasAppPort(true);
      } else {
        missesRef.current += 1;
        if (missesRef.current >= 3) setHasAppPort(false);
      }
    };
    void check();
    const id = window.setInterval(check, 4000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [active, isMobile, browserPref, session.worktreePath]);
  const browserVisible =
    !isMobile && (browserPref === "open" || (browserPref !== "closed" && hasAppPort));

  return (
    <div className="workspace" style={{ display: active ? "flex" : "none" }}>
      <div
        className="terminals-col"
        ref={colRef}
        style={!isMobile && browserVisible ? { flex: `0 0 calc(${splitRatio * 100}% - 3px)` } : undefined}
      >
        <div
          className="claude-pane"
          style={{
            display: showClaude ? "flex" : "none",
            ...(!isMobile && hasTerminals
              ? { flexGrow: claudeRatio, flexBasis: 0 }
              : { flexGrow: 1, flexBasis: 0 })
          }}
        >
          <div className="quick-prompt-row">
            <div className="claude-view-toggle" role="group" aria-label="Claude view">
              <button
                type="button"
                className={claudeView === "terminal" ? "active" : ""}
                onClick={() => setClaudeView("terminal")}
                title="Terminal view"
              >
                Terminal
              </button>
              <button
                type="button"
                className={claudeView === "chat" ? "active" : ""}
                onClick={() => setClaudeView("chat")}
                title="Chat view (rich)"
              >
                Chat
              </button>
            </div>
            {claudeView === "terminal" && (
              <QuickPromptBar
                sessionId={session.id}
                disabled={!claudeRunning || session.claudePty.claudeAlive === false}
                onSend={onInstruct}
              />
            )}
            {session.claudePty.state !== "none" && (
              <button
                type="button"
                className="pane-close"
                onClick={() => onClosePty(session.id, "claude")}
                title="Close Claude terminal"
              >
                ×
              </button>
            )}
          </div>
          <div className="pane-body">
            {claudeView === "chat" && claudeRunning ? (
              <ChatPane sessionId={session.id} branch={session.branch} />
            ) : (
              <>
                {claudeRunning && (
                  <TerminalPane key={claudeKey} ptyId={session.claudePty.id!} isActive={active && showClaude} />
                )}
                <ClaudePaneOverlay session={session} onEnsureClaude={onEnsureClaude} />
              </>
            )}
          </div>
        </div>
        {!isMobile && hasTerminals && (
          <div
            className="term-divider col claude-deck-divider"
            role="separator"
            aria-orientation="horizontal"
            title="Drag to resize"
            onPointerDown={(e) => {
              e.preventDefault();
              claudeDragRef.current = true;
              try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
            }}
            onPointerMove={(e) => {
              if (!claudeDragRef.current) return;
              const c = colRef.current;
              if (!c) return;
              const rect = c.getBoundingClientRect();
              const raw = (e.clientY - rect.top) / rect.height;
              setClaudeRatio(Math.min(0.85, Math.max(0.15, raw)));
            }}
            onPointerUp={(e) => {
              if (!claudeDragRef.current) return;
              claudeDragRef.current = false;
              try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
              localStorage.setItem(LS_CLAUDE_RATIO, String(claudeRatio));
            }}
            onPointerCancel={(e) => {
              if (!claudeDragRef.current) return;
              claudeDragRef.current = false;
              try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
            }}
          />
        )}
        <div
          className="terminals-deck"
          style={{
            display: showDeck ? "flex" : "none",
            ...(!isMobile && hasTerminals ? { flexGrow: 1 - claudeRatio, flexBasis: 0 } : {}),
            ...(!isMobile && !hasTerminals ? { flex: "0 0 auto" } : {})
          }}
        >
          {!hasTerminals ? (
            <div className="terminals-deck-empty">
              <span>No terminals open</span>
              <button type="button" className="btn" onClick={() => onAddTerminal(session.id)}>
                + New terminal
              </button>
            </div>
          ) : isMobile ? (
            <TermLeaf
              term={termById.get(mobileLeafId ?? "")}
              active={active && showDeck}
              onClose={(role) => onCloseTerminal(session.id, role)}
              onRestart={(role) => onRestartTerminal(session.id, role)}
            />
          ) : (
            tree && (
              <TermTreeView
                node={tree}
                path=""
                active={active}
                termById={termById}
                onClose={(role) => onCloseTerminal(session.id, role)}
                onRestart={(role) => onRestartTerminal(session.id, role)}
                onResize={resizeSplit}
                onCommit={commitTree}
              />
            )
          )}
        </div>
      </div>
      {browserVisible && (
        <>
          <div
            className="split-divider"
            onPointerDown={onDividerPointerDown}
            onPointerMove={onDividerPointerMove}
            onPointerUp={onDividerPointerUp}
            onPointerCancel={onDividerPointerUp}
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize"
          />
          <BrowserPane
            cwd={session.worktreePath}
            active={active}
            onWired={onWired}
            onManualNav={() => onPinBrowserOpen(session.id)}
            onClose={() => onCloseBrowser(session.id)}
          />
        </>
      )}
    </div>
  );
}

function App() {
  const [sessions, setSessions] = useState<DevEnvSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(
    () => localStorage.getItem(LS_SELECTED)
  );
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [mobilePane, setMobilePane] = useState<"claude" | "shell">("claude");
  const [showAll, setShowAll] = useState(() => localStorage.getItem(LS_SHOW_ALL) === "1");
  // Per-session browser override ("open" = forced visible, "closed" = forced
  // hidden; unset = auto, i.e. visible only while an app.port is detected).
  const [browserPref, setBrowserPref] = useState<Record<string, "open" | "closed">>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<null | "new-worktree" | "start-session" | "confirm-delete" | "settings">(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const toastTimer = useRef<number | null>(null);
  const ensuredRef = useRef<Set<string>>(new Set());
  const wiredByCwd = useRef<Map<string, WiredInfo>>(new Map());
  const [splitRatio, setSplitRatio] = useState<number>(() => {
    const v = Number(localStorage.getItem(LS_SPLIT_RATIO));
    // Default: terminals 1/2, app pane 1/2.
    return Number.isFinite(v) && v > 0.1 && v < 0.9 ? v : 0.5;
  });
  const draggingRef = useRef(false);
  const shellWrapRef = useRef<HTMLDivElement | null>(null);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 4000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/sessions");
      const data = await res.json();
      // Normalise `terminals` to an array so a stale backend (new bundle loaded
      // before the server restarts) can't crash the deck on `.map`.
      const list: DevEnvSession[] = (data.sessions ?? []).map((s: DevEnvSession) => ({
        ...s,
        terminals: Array.isArray(s.terminals) ? s.terminals : []
      }));
      setSessions(list);
      ensuredRef.current.clear();
    } catch {
      // transient poll failure; keep the last list
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  // Auto-select: keep the stored selection while it exists; fall back to the
  // first VISIBLE session. The selected session always stays visible even
  // when it fails the active filter, so toggling Show-all off never yanks
  // the workspace out from under you.
  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  // Excluded (system/internal) sessions hide by default — but never the one
  // you're actively viewing, and "Show all" reveals them like any hidden row.
  const visibleSessions = sessions.filter(
    (s) => showAll || s.id === selectedId || (isActiveSession(s) && !s.excluded)
  );
  const hiddenCount = sessions.length - visibleSessions.length;
  useEffect(() => {
    if (visibleSessions.length === 0) return;
    if (!selected) {
      const first = visibleSessions[0];
      setSelectedId(first.id);
      setVisited((v) => new Set(v).add(first.id));
    }
  }, [visibleSessions, selected]);

  function toggleShowAll() {
    setShowAll((prev) => {
      const next = !prev;
      localStorage.setItem(LS_SHOW_ALL, next ? "1" : "0");
      return next;
    });
  }

  useEffect(() => {
    if (selectedId) {
      localStorage.setItem(LS_SELECTED, selectedId);
      setVisited((v) => (v.has(selectedId) ? v : new Set(v).add(selectedId)));
    }
  }, [selectedId]);

  const ensurePty = useCallback(
    async (sessionId: string, role: "claude", resume = false) => {
      const key = `${sessionId}:${role}`;
      if (ensuredRef.current.has(key)) return;
      ensuredRef.current.add(key);
      try {
        const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/ptys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role, resume })
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast(data?.error ?? `PTY start failed: HTTP ${res.status}`);
          return;
        }
        await refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh, toast]
  );

  // No lazy shell spawn — terminals are opened explicitly via the + button.

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const closePty = useCallback(
    async (sessionId: string, role: "claude") => {
      try {
        await fetch(`/sessions/${encodeURIComponent(sessionId)}/ptys/${role}`, { method: "DELETE" });
      } catch {}
      ensuredRef.current.delete(`${sessionId}:${role}`);
      await refresh();
    },
    [refresh]
  );

  // Open a new shell terminal in the session's deck (server allocates the role;
  // the next poll tiles it in).
  const addTerminal = useCallback(
    async (sessionId: string) => {
      try {
        const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/terminals`, { method: "POST" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast(data?.error ?? `terminal start failed: HTTP ${res.status}`);
          return;
        }
        await refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh, toast]
  );

  const closeTerminal = useCallback(
    async (sessionId: string, role: string) => {
      try {
        await fetch(`/sessions/${encodeURIComponent(sessionId)}/ptys/${encodeURIComponent(role)}`, { method: "DELETE" });
      } catch {}
      await refresh();
    },
    [refresh]
  );

  const restartTerminal = useCallback(
    async (sessionId: string, role: string) => {
      try {
        const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/ptys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role })
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast(data?.error ?? `restart failed: HTTP ${res.status}`);
          return;
        }
        await refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh, toast]
  );

  const closeTab = useCallback(
    async (sessionId: string) => {
      const idx = visibleSessions.findIndex((s) => s.id === sessionId);
      try {
        const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/close`, { method: "POST" });
        // 404 = already gone (double-click ×, another client) — treat as
        // success and proceed with local cleanup.
        if (!res.ok && res.status !== 404) {
          const data = await res.json().catch(() => ({}));
          toast(data?.error ?? `close failed: HTTP ${res.status}`);
          return;
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
        return;
      }
      setVisited((v) => {
        const next = new Set(v);
        next.delete(sessionId);
        return next;
      });
      setBrowserPref((p) => {
        if (!(sessionId in p)) return p;
        const next = { ...p };
        delete next[sessionId];
        return next;
      });
      // Re-read the selection at resolution time: the user may have clicked
      // another tab while the close round-trip was in flight.
      if (selectedIdRef.current === sessionId) {
        const neighbors = visibleSessions.filter((s) => s.id !== sessionId);
        const neighbor = neighbors[idx] ?? neighbors[idx - 1] ?? null;
        setSelectedId(neighbor ? neighbor.id : null);
      }
      await refresh();
    },
    [visibleSessions, refresh, toast]
  );

  const closeBrowser = useCallback((sessionId: string) => {
    setBrowserPref((p) => ({ ...p, [sessionId]: "closed" }));
  }, []);

  // Manual URL navigation pins the pane open — otherwise the app.port
  // visibility poll could unmount it mid-browse.
  const pinBrowserOpen = useCallback((sessionId: string) => {
    setBrowserPref((p) => (p[sessionId] === "open" ? p : { ...p, [sessionId]: "open" }));
  }, []);

  function openBrowser() {
    setMenuOpen(false);
    if (!selected) return;
    setBrowserPref((p) => ({ ...p, [selected.id]: "open" }));
  }

  const onEnsureClaude = useCallback(
    (sessionId: string, resume: boolean) => {
      ensuredRef.current.delete(`${sessionId}:claude`);
      void ensurePty(sessionId, "claude", resume);
    },
    [ensurePty]
  );

  const instruct = useCallback(
    async (sessionId: string, text: string): Promise<boolean> => {
      try {
        const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/instruct`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text })
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast(data?.error ?? `instruct failed: HTTP ${res.status}`);
          return false;
        }
        return true;
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [toast]
  );

  function select(id: string) {
    setSelectedId(id);
  }

  async function clearStale() {
    setMenuOpen(false);
    try {
      const res = await fetch("/sessions/cleanup", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data?.error ?? `cleanup failed: HTTP ${res.status}`);
        return;
      }
      toast(`${data.removed?.length ?? 0} session(s) cleared`);
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  }

  async function menuInstruct(text: string) {
    setMenuOpen(false);
    if (!selected) return;
    const ok = await instruct(selected.id, text);
    if (ok) toast("Sent to Claude");
  }

  async function deleteSelected() {
    setDialog(null);
    if (!selected) return;
    const idx = sessions.findIndex((s) => s.id === selected.id);
    try {
      const res = await fetch(`/sessions/${encodeURIComponent(selected.id)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(data?.error ?? `delete failed: HTTP ${res.status}`);
        return;
      }
      const neighbor = sessions[idx + 1] ?? sessions[idx - 1] ?? null;
      setSelectedId(neighbor ? neighbor.id : null);
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  }

  async function openAppInNewTab() {
    setMenuOpen(false);
    if (!selected) return;
    const wired = wiredByCwd.current.get(selected.worktreePath);
    if (wired?.canvasUrl) {
      window.open(wired.canvasUrl, "_blank", "noopener");
      return;
    }
    try {
      const res = await fetch(`/app-port?cwd=${encodeURIComponent(selected.worktreePath)}`);
      if (res.ok) {
        const { port } = await res.json();
        window.open(`http://${window.location.hostname}:${port}`, "_blank", "noopener");
        return;
      }
    } catch {}
    toast("No app detected for this session (missing app.port).");
  }

  const onWired = useCallback((info: WiredInfo) => {
    wiredByCwd.current.set(info.cwd, info);
  }, []);

  function onDividerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    draggingRef.current = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  }

  function onDividerPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const wrap = shellWrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const raw = (e.clientX - rect.left) / rect.width;
    const clamped = Math.min(0.9, Math.max(0.1, raw));
    setSplitRatio(clamped);
  }

  function onDividerPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    localStorage.setItem(LS_SPLIT_RATIO, String(splitRatio));
  }

  // Close the menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

  const visible = sessions.filter((s) => visited.has(s.id));

  return (
    <>
      <div className="header">
        <div className="menu-wrap" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="btn menu-btn"
            title="Menu"
            aria-label="Menu"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect x="1" y="2" width="12" height="1.6" fill="currentColor" />
              <rect x="1" y="6.2" width="12" height="1.6" fill="currentColor" />
              <rect x="1" y="10.4" width="12" height="1.6" fill="currentColor" />
            </svg>
          </button>
          {menuOpen && (
            <div className="menu">
              <button type="button" onClick={() => { setMenuOpen(false); setDialog("start-session"); }}>
                New session…
              </button>
              <button type="button" onClick={() => { setMenuOpen(false); setDialog("new-worktree"); }}>
                New worktree…
              </button>
              <button type="button" onClick={() => void clearStale()}>
                Clear stale sessions
              </button>
              <button type="button" onClick={() => { setMenuOpen(false); toggleShowAll(); }}>
                {showAll
                  ? "Show active only"
                  : `Show all sessions${hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}`}
              </button>
              <button type="button" onClick={() => { setMenuOpen(false); setDialog("settings"); }}>
                Settings…
              </button>
              <div className="menu-sep" />
              <button
                type="button"
                disabled={!selected}
                onClick={() => void menuInstruct(
                  "Commit any pending changes, push the branch, and open a PR with gh; report the PR URL."
                )}
              >
                Create PR
              </button>
              <button
                type="button"
                disabled={!selected}
                onClick={() => void menuInstruct(
                  "Commit any pending changes with a sensible message and push the branch."
                )}
              >
                Commit &amp; push
              </button>
              <button type="button" disabled={!selected} onClick={() => void menuInstruct("/run")}>
                Run
              </button>
              <div className="menu-sep" />
              <button
                type="button"
                disabled={!selected}
                onClick={() => { setMenuOpen(false); if (selected) addTerminal(selected.id); }}
              >
                New terminal
              </button>
              <button
                type="button"
                disabled={!selected || isMobile || browserPref[selected.id] === "open"}
                onClick={openBrowser}
                title={isMobile ? "Browser pane is desktop-only" : "Show the browser pane for this tab"}
              >
                Open browser
              </button>
              <button type="button" disabled={!selected} onClick={() => void openAppInNewTab()}>
                Open app in browser tab
              </button>
              {selected?.isWorktree && (
                <>
                  <div className="menu-sep" />
                  <button type="button" className="danger" onClick={() => { setMenuOpen(false); setDialog("confirm-delete"); }}>
                    Delete worktree
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="tabs">
          {visibleSessions.map((s) => (
            <span
              key={s.id}
              className={`tab ${s.id === selectedId ? "active" : ""} ${s.lastStatus === "stale" ? "stale" : ""}`}
              onClick={() => select(s.id)}
              title={`${s.worktreePath}\n${s.lastStatus}${s.external ? " · external" : ""}`}
            >
              {s.lastStatus === "working" && <span className="spinner" aria-hidden="true" />}
              {s.lastStatus === "waiting" && <span className="badge-waiting" aria-hidden="true" />}
              <span className="tab-label">{tabLabel(s)}</span>
              {s.dirty === true && <span className="dirty-dot" title="Uncommitted changes" />}
              <span
                className="close"
                title="Close tab (terminals die; the directory and worktree stay)"
                onClick={(e) => { e.stopPropagation(); void closeTab(s.id); }}
              >
                ×
              </span>
            </span>
          ))}
          {sessions.length === 0 && <span className="tabs-empty">No sessions — create a worktree or start claude anywhere.</span>}
          {sessions.length > 0 && visibleSessions.length === 0 && (
            <span className="tabs-empty">No active sessions — {hiddenCount} hidden.</span>
          )}
        </div>
        <button
          type="button"
          className="btn new-term-btn"
          disabled={!selected}
          title="Open a new terminal in this session"
          onClick={() => { if (selected) addTerminal(selected.id); }}
        >
          + Terminal
        </button>
        <TermThemeToggle />
        {isMobile && selected && (
          <div className="segmented" role="tablist" aria-label="Pane">
            <button
              type="button"
              className={mobilePane === "claude" ? "on" : ""}
              onClick={() => setMobilePane("claude")}
            >
              Claude
            </button>
            <button
              type="button"
              className={mobilePane === "shell" ? "on" : ""}
              onClick={() => setMobilePane("shell")}
            >
              Shell
            </button>
          </div>
        )}
      </div>

      <div className="shell-wrap" ref={shellWrapRef}>
        {visible.map((s) => (
          <SessionWorkspace
            key={s.id}
            session={s}
            active={s.id === selectedId}
            isMobile={isMobile}
            mobilePane={mobilePane}
            splitRatio={splitRatio}
            browserPref={browserPref[s.id]}
            onDividerPointerDown={onDividerPointerDown}
            onDividerPointerMove={onDividerPointerMove}
            onDividerPointerUp={onDividerPointerUp}
            onWired={onWired}
            onEnsureClaude={onEnsureClaude}
            onInstruct={instruct}
            onClosePty={(sid, role) => void closePty(sid, role)}
            onAddTerminal={addTerminal}
            onCloseTerminal={closeTerminal}
            onRestartTerminal={restartTerminal}
            onCloseBrowser={closeBrowser}
            onPinBrowserOpen={pinBrowserOpen}
          />
        ))}
        {visibleSessions.length === 0 && (
          <div className="empty-state">
            <p>No active sessions.</p>
            <div className="pane-overlay-row">
              <button type="button" className="btn primary" onClick={() => setDialog("new-worktree")}>
                New worktree…
              </button>
              {hiddenCount > 0 && (
                <button type="button" className="btn" onClick={() => toggleShowAll()}>
                  Show all sessions ({hiddenCount} hidden)
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {dialog === "new-worktree" && (
        <NewWorktreeDialog
          initialRepoPath={selected?.projectPath}
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            setSelectedId(id);
            setVisited((v) => new Set(v).add(id));
            void refresh();
          }}
          onError={(m) => toast(m)}
        />
      )}
      {dialog === "start-session" && (
        <StartSessionDialog
          initialRepoPath={selected?.projectPath}
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            setSelectedId(id);
            setVisited((v) => new Set(v).add(id));
            void refresh();
          }}
          onError={(m) => toast(m)}
        />
      )}
      {dialog === "confirm-delete" && selected && (
        <ConfirmDeleteDialog
          label={tabLabel(selected)}
          detail={selected.worktreePath}
          onClose={() => setDialog(null)}
          onConfirm={() => void deleteSelected()}
        />
      )}
      {dialog === "settings" && (
        <SettingsDialog
          onClose={() => { setDialog(null); void refresh(); }}
          onError={(m) => toast(m)}
        />
      )}
      <Toast message={toastMsg} />
    </>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
