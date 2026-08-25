// The sessions rail: ONE list for every conversation this node can see -
// local threads, threads living on other mesh nodes (badged by node accent,
// opened on their home node), and the remote-shell entries. The user's
// arrangement (groups, manual order, read marks, archive) is the organizer
// document served at /api/sidebar; it stores row KEYS only, so the thread
// stores on either side never learn about UI grouping.
//
// Interaction surface:
//  - click        open (local: in place; remote: on its home node, new tab)
//  - right-click / long-press   context menu (rename, read state, move to
//                 group, archive, delete - remote rows only get what their
//                 home node ownership allows)
//  - drag         reorder within a group or drop on a group header to move
//  - "+ New"      picker: this node, any mesh peer, or a remote shell

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface RailThread {
  id: string;
  title: string;
  source: string;
  updatedAt: string | null;
  runningSince?: string | null;
  pendingInputCount?: number;
  remoteShell?: { transport: string; target?: string } | null;
}

export interface RailMeshThread {
  id: string;
  title: string | null;
  lastMessageAt: string | null;
  openUrl: string | null;
}

export interface RailMeshNode {
  node: string;
  accentColor: string | null;
  status: string;
  openBase?: string | null;
  threads: RailMeshThread[];
}

export interface RailSelf {
  node: string | null;
  accentColor: string | null;
}

export interface RailTransport {
  name: string;
  label?: string;
  via?: string;
  routingTarget?: string;
}

interface SidebarState {
  groups: { id: string; name: string; collapsed: boolean }[];
  membership: Record<string, string>;
  order: Record<string, string[]>;
  read: Record<string, string>;
  archived: string[];
  /** The unread epoch - activity before this never reads as unread. */
  baselineAt: string | null;
}

interface Row {
  key: string;
  kind: "local" | "remote";
  id: string;
  title: string;
  nodeName: string | null;
  accent: string | null;
  activity: string | null;
  running: boolean;
  queued: number;
  source: string | null;
  rshTransport: string | null;
  openUrl: string | null;
}

const EMPTY_SIDEBAR: SidebarState = { groups: [], membership: {}, order: {}, read: {}, archived: [], baselineAt: null };
const UNGROUPED = "_ungrouped";
const ARCHIVED = "_archived";

function shortNode(name: string | null | undefined): string {
  return (name ?? "").replace(/^goncalos-/, "");
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const min = Math.floor((Date.now() - d.getTime()) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}

function newGroupId(): string {
  return `g-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Context menu model ──────────────────────────────────────────────────────

interface MenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onPick?: () => void;
  submenu?: MenuItem[];
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const [items, setItems] = useState<MenuItem[]>(menu.items);
  const [stack, setStack] = useState<MenuItem[][]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setItems(menu.items); setStack([]); }, [menu]);

  useEffect(() => {
    const away = (e: MouseEvent | TouchEvent) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", away);
    document.addEventListener("touchstart", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("touchstart", away);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  // Keep the menu inside the viewport.
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  useEffect(() => {
    setPos({ x: menu.x, y: menu.y });
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({
        x: Math.min(menu.x, Math.max(4, window.innerWidth - r.width - 4)),
        y: Math.min(menu.y, Math.max(4, window.innerHeight - r.height - 4))
      });
    });
  }, [menu]);

  return (
    <div ref={ref} className="wc-ctx" style={{ left: pos.x, top: pos.y }} role="menu">
      {stack.length > 0 && (
        <button
          type="button"
          className="wc-ctx-item wc-ctx-back"
          onClick={() => {
            setItems(stack[stack.length - 1]);
            setStack((s) => s.slice(0, -1));
          }}
        >
          &#8249; Back
        </button>
      )}
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          className={`wc-ctx-item${it.danger ? " wc-ctx-item--danger" : ""}`}
          disabled={it.disabled}
          title={it.title}
          onClick={() => {
            if (it.submenu) {
              setStack((s) => [...s, items]);
              setItems(it.submenu);
              return;
            }
            it.onPick?.();
            onClose();
          }}
        >
          <span className="wc-ctx-label">{it.label}</span>
          {it.submenu && <span className="wc-ctx-more" aria-hidden>&#8250;</span>}
        </button>
      ))}
    </div>
  );
}

// ── Small centered prompt (rename / new group). window.prompt is blocked in
//    some embedded contexts and unstylable everywhere, so it is a real dialog. ──

function TextPrompt({ title, initial, onSubmit, onClose }: {
  title: string;
  initial: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.select(); }, []);
  const submit = () => {
    const v = value.trim();
    if (v) onSubmit(v);
    onClose();
  };
  return (
    <div className="wc-prompt-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wc-prompt" role="dialog" aria-label={title}>
        <div className="wc-prompt-title">{title}</div>
        <input
          ref={inputRef}
          value={value}
          maxLength={120}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onClose();
          }}
        />
        <div className="wc-prompt-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="wc-prompt-save" onClick={submit}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── The rail ────────────────────────────────────────────────────────────────

export function SessionsRail(props: {
  threads: RailThread[];
  meshNodes: RailMeshNode[];
  self: RailSelf;
  transports: RailTransport[];
  activeId: string | null;
  listOpen: boolean;
  onToggleList: () => void;
  onSelect: (id: string) => void;
  onNewLocal: () => void;
  onOpenRemoteShell: (t: RailTransport) => void;
  onDeleteLocal: (id: string) => void;
  onRenameLocal: (id: string, title: string) => Promise<void>;
}) {
  const {
    threads, meshNodes, self, transports, activeId,
    listOpen, onToggleList, onSelect, onNewLocal, onOpenRemoteShell, onDeleteLocal, onRenameLocal
  } = props;

  const [sidebar, setSidebar] = useState<SidebarState>(EMPTY_SIDEBAR);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [prompt, setPrompt] = useState<{ title: string; initial: string; onSubmit: (v: string) => void } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [archOpen, setArchOpen] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ section: string; beforeKey: string | null } | null>(null);
  const newRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number>(0);

  // Load the organizer once; save with a short debounce on every change.
  const organizerLoaded = useRef(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/sidebar", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (alive && d && typeof d === "object") {
          setSidebar({ ...EMPTY_SIDEBAR, ...d });
          organizerLoaded.current = true;
        }
      })
      .catch(() => { /* organizer stays default */ });
    return () => { alive = false; };
  }, []);

  const update = useCallback((mutate: (s: SidebarState) => SidebarState) => {
    setSidebar((prev) => {
      const next = mutate(prev);
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void fetch("/api/sidebar", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next)
        }).catch(() => { /* next change retries */ });
      }, 500);
      return next;
    });
  }, []);

  // Close the + New picker on click-away.
  useEffect(() => {
    if (!newOpen) return;
    const away = (e: MouseEvent | TouchEvent) => {
      if (newRef.current && e.target instanceof Node && newRef.current.contains(e.target)) return;
      setNewOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("touchstart", away);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("touchstart", away);
    };
  }, [newOpen]);

  // ── Unified rows ──
  const rows = useMemo<Row[]>(() => {
    const local = threads.map((t): Row => ({
      key: `local:${t.id}`,
      kind: "local",
      id: t.id,
      title: t.title || "New conversation",
      nodeName: shortNode(self.node) || null,
      accent: self.accentColor,
      activity: t.updatedAt,
      running: Boolean(t.runningSince),
      queued: t.pendingInputCount ?? 0,
      source: t.source && t.source !== "chat" ? t.source : null,
      rshTransport: t.remoteShell?.transport ?? null,
      openUrl: null
    }));
    const remote = meshNodes.flatMap((n) =>
      n.threads.map((t): Row => ({
        key: `${n.node}:${t.id}`,
        kind: "remote",
        id: t.id,
        title: t.title || "New conversation",
        nodeName: shortNode(n.node),
        accent: n.accentColor,
        activity: t.lastMessageAt,
        running: false,
        queued: 0,
        source: null,
        rshTransport: null,
        openUrl: t.openUrl
      }))
    );
    return [...local, ...remote];
  }, [threads, meshNodes, self]);

  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);

  const sectionOf = useCallback((key: string): string => {
    if (sidebar.archived.includes(key)) return ARCHIVED;
    const gid = sidebar.membership[key];
    return gid && sidebar.groups.some((g) => g.id === gid) ? gid : UNGROUPED;
  }, [sidebar]);

  // Rows per section: manual order first, the rest by recency.
  const sectionRows = useCallback((section: string): Row[] => {
    const members = rows.filter((r) => sectionOf(r.key) === section);
    const ordered = (sidebar.order[section] ?? []).map((k) => members.find((r) => r.key === k)).filter(Boolean) as Row[];
    const rest = members
      .filter((r) => !ordered.includes(r))
      .sort((a, b) => Date.parse(b.activity ?? "0") - Date.parse(a.activity ?? "0"));
    return [...ordered, ...rest];
  }, [rows, sidebar, sectionOf]);

  const unread = useCallback((r: Row): boolean => {
    if (!r.activity) return false;
    if (r.kind === "local" && r.id === activeId) return false;
    const mark = sidebar.read[r.key] ?? sidebar.baselineAt;
    if (!mark) return false; // epoch not stamped yet - nothing is unread
    return Date.parse(mark) < Date.parse(r.activity);
  }, [sidebar, activeId]);

  const markRead = useCallback((key: string, iso?: string) => {
    update((s) => ({ ...s, read: { ...s.read, [key]: iso ?? new Date().toISOString() } }));
  }, [update]);

  const markUnread = useCallback((key: string) => {
    update((s) => {
      const read = { ...s.read };
      delete read[key];
      return { ...s, read };
    });
  }, [update]);

  // Cold start: stamp the unread epoch once. Anything that happened before
  // the user first saw this feature reads as read; only activity AFTER the
  // epoch (or after a per-row mark) can be unread.
  const baselined = useRef(false);
  useEffect(() => {
    if (baselined.current || !organizerLoaded.current) return;
    baselined.current = true;
    if (!sidebar.baselineAt) update((s) => ({ ...s, baselineAt: new Date().toISOString() }));
  }, [sidebar.baselineAt, update]);

  // The open conversation is by definition read, including while new activity
  // streams into it.
  const activeKey = activeId ? `local:${activeId}` : null;
  const activeActivity = activeKey ? rowByKey.get(activeKey)?.activity : null;
  useEffect(() => {
    if (!activeKey || !activeActivity) return;
    const mark = sidebar.read[activeKey];
    if (!mark || Date.parse(mark) < Date.parse(activeActivity)) markRead(activeKey, new Date().toISOString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, activeActivity]);

  // ── Organizer mutations ──
  const moveTo = useCallback((key: string, section: string, beforeKey: string | null = null) => {
    update((s) => {
      const next: SidebarState = {
        ...s,
        membership: { ...s.membership },
        order: Object.fromEntries(Object.entries(s.order).map(([k, v]) => [k, v.filter((x) => x !== key)])),
        archived: s.archived.filter((k) => k !== key)
      };
      if (section === ARCHIVED) next.archived = [...next.archived, key];
      else if (section === UNGROUPED) delete next.membership[key];
      else next.membership[key] = section;
      // Snapshot the section's rendered order so one drop pins the whole list.
      const target = sectionRows(section).map((r) => r.key).filter((k) => k !== key);
      const at = beforeKey ? target.indexOf(beforeKey) : -1;
      if (at >= 0) target.splice(at, 0, key);
      else target.push(key);
      next.order = { ...next.order, [section]: target };
      return next;
    });
  }, [update, sectionRows]);

  const addGroup = useCallback((name: string, memberKey?: string) => {
    const id = newGroupId();
    update((s) => ({
      ...s,
      groups: [...s.groups, { id, name, collapsed: false }],
      membership: memberKey ? { ...s.membership, [memberKey]: id } : s.membership
    }));
  }, [update]);

  const renameGroup = useCallback((id: string, name: string) => {
    update((s) => ({ ...s, groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)) }));
  }, [update]);

  const removeGroup = useCallback((id: string) => {
    update((s) => ({
      ...s,
      groups: s.groups.filter((g) => g.id !== id),
      membership: Object.fromEntries(Object.entries(s.membership).filter(([, v]) => v !== id)),
      order: Object.fromEntries(Object.entries(s.order).filter(([k]) => k !== id))
    }));
  }, [update]);

  const toggleGroup = useCallback((id: string) => {
    update((s) => ({ ...s, groups: s.groups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)) }));
  }, [update]);

  // ── Context menus ──
  const rowMenu = useCallback((r: Row, x: number, y: number) => {
    const section = sectionOf(r.key);
    const isArchived = section === ARCHIVED;
    const moveItems: MenuItem[] = [
      ...sidebar.groups.map((g) => ({
        label: g.name,
        disabled: section === g.id,
        onPick: () => moveTo(r.key, g.id)
      })),
      { label: "Ungrouped", disabled: section === UNGROUPED, onPick: () => moveTo(r.key, UNGROUPED) },
      {
        label: "New group…",
        onPick: () => setPrompt({
          title: "New group",
          initial: "",
          onSubmit: (name) => addGroup(name, r.key)
        })
      }
    ];
    const items: MenuItem[] = [];
    if (r.kind === "remote") {
      items.push({
        label: `Open on ${r.nodeName}`,
        disabled: !r.openUrl,
        onPick: () => { if (r.openUrl) { window.open(r.openUrl, "_blank", "noopener"); markRead(r.key); } }
      });
    }
    items.push(
      unread(r)
        ? { label: "Mark as read", onPick: () => markRead(r.key) }
        : { label: "Mark as unread", disabled: !r.activity, onPick: () => markUnread(r.key) },
      { label: "Move to", submenu: moveItems },
      isArchived
        ? { label: "Unarchive", onPick: () => moveTo(r.key, UNGROUPED) }
        : { label: "Archive", onPick: () => moveTo(r.key, ARCHIVED) }
    );
    if (r.kind === "local") {
      items.splice(0, 0, {
        label: "Rename…",
        onPick: () => setPrompt({
          title: "Rename conversation",
          initial: r.title,
          onSubmit: (name) => { void onRenameLocal(r.id, name); }
        })
      });
      items.push({ label: "Delete", danger: true, onPick: () => onDeleteLocal(r.id) });
    } else {
      items.push({
        label: "Rename…",
        disabled: true,
        title: `This conversation lives on ${r.nodeName}; rename it there.`
      });
    }
    setMenu({ x, y, items });
  }, [sidebar, sectionOf, moveTo, addGroup, markRead, markUnread, unread, onDeleteLocal, onRenameLocal]);

  const groupMenu = useCallback((g: { id: string; name: string }, x: number, y: number) => {
    setMenu({
      x, y,
      items: [
        {
          label: "Rename group…",
          onPick: () => setPrompt({ title: "Rename group", initial: g.name, onSubmit: (name) => renameGroup(g.id, name) })
        },
        { label: "Delete group", danger: true, title: "Sessions return to Ungrouped", onPick: () => removeGroup(g.id) }
      ]
    });
  }, [renameGroup, removeGroup]);

  const listMenu = useCallback((x: number, y: number) => {
    setMenu({
      x, y,
      items: [
        { label: "New group…", onPick: () => setPrompt({ title: "New group", initial: "", onSubmit: (name) => addGroup(name) }) }
      ]
    });
  }, [addGroup]);

  // Long-press = the phone's right-click. contextmenu covers Android; the
  // timer covers iOS Safari, which never fires it. Fires at the touch point.
  const pressTimer = useRef<number>(0);
  const pressStart = useCallback((fire: (x: number, y: number) => void) => (e: React.TouchEvent) => {
    if (e.touches.length > 2) return;
    const t = e.touches[0];
    const x = t.clientX, y = t.clientY;
    window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => fire(x, y), 550);
  }, []);
  const pressEnd = useCallback(() => window.clearTimeout(pressTimer.current), []);

  // ── Drag and drop ──
  const onRowDragStart = useCallback((r: Row) => (e: React.DragEvent) => {
    e.dataTransfer.setData("text/wc-key", r.key);
    e.dataTransfer.effectAllowed = "move";
    setDragKey(r.key);
  }, []);
  const onRowDragOver = useCallback((r: Row) => (e: React.DragEvent) => {
    if (!dragKey || dragKey === r.key) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropHint({ section: sectionOf(r.key), beforeKey: r.key });
  }, [dragKey, sectionOf]);
  const onRowDrop = useCallback((r: Row) => (e: React.DragEvent) => {
    e.preventDefault();
    const key = e.dataTransfer.getData("text/wc-key") || dragKey;
    if (key && key !== r.key) moveTo(key, sectionOf(r.key), r.key);
    setDragKey(null);
    setDropHint(null);
  }, [dragKey, moveTo, sectionOf]);
  const onSectionDragOver = useCallback((section: string) => (e: React.DragEvent) => {
    if (!dragKey) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropHint({ section, beforeKey: null });
  }, [dragKey]);
  const onSectionDrop = useCallback((section: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const key = e.dataTransfer.getData("text/wc-key") || dragKey;
    if (key) moveTo(key, section);
    setDragKey(null);
    setDropHint(null);
  }, [dragKey, moveTo]);
  const onDragEnd = useCallback(() => { setDragKey(null); setDropHint(null); }, []);

  // ── Row rendering ──
  const renderRow = (r: Row) => {
    const isUnread = unread(r);
    const isActive = r.kind === "local" && r.id === activeId;
    const hinted = dropHint?.beforeKey === r.key;
    const open = () => {
      if (r.kind === "local") { onSelect(r.id); markRead(r.key); }
      else if (r.openUrl) { window.open(r.openUrl, "_blank", "noopener"); markRead(r.key); }
    };
    const meta: React.ReactNode[] = [];
    if (r.source) meta.push(<span key="src" className="wc-thread-src">{r.source}</span>);
    if (r.running) meta.push(<span key="run" className="wc-thread-src">Working</span>);
    else if (r.queued > 0) meta.push(<span key="q" className="wc-thread-src">{r.queued} queued</span>);
    if (r.kind === "remote" && r.nodeName) meta.push(<span key="node" className="wc-thread-node">{r.nodeName}</span>);
    const when = fmtWhen(r.activity);
    if (when) meta.push(<span key="when" className="wc-thread-when">{when}</span>);
    return (
      <div
        key={r.key}
        className={[
          "wc-thread",
          isActive ? "wc-thread--active" : "",
          isUnread ? "wc-thread--unread" : "",
          dragKey === r.key ? "wc-thread--dragging" : "",
          hinted ? "wc-thread--drophint" : ""
        ].filter(Boolean).join(" ")}
        draggable
        onDragStart={onRowDragStart(r)}
        onDragOver={onRowDragOver(r)}
        onDrop={onRowDrop(r)}
        onDragEnd={onDragEnd}
        onContextMenu={(e) => { e.preventDefault(); rowMenu(r, e.clientX, e.clientY); }}
        onTouchStart={pressStart((x, y) => rowMenu(r, x, y))}
        onTouchMove={pressEnd}
        onTouchEnd={pressEnd}
      >
        <span
          className="wc-row-dot"
          style={{ background: r.accent || "#6a746b" }}
          title={r.nodeName ?? undefined}
          aria-hidden
        />
        <button type="button" className="wc-thread-open" onClick={open} title={r.title}>
          <span className="wc-thread-main">
            <span className="wc-thread-title">{r.title}</span>
            {meta.length > 0 && <span className="wc-thread-meta">{meta}</span>}
          </span>
        </button>
        {r.kind === "remote" ? (
          <svg className="wc-row-out" width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
            <path d="M3 8 8 3M4.2 3H8v3.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        ) : (
          <button
            type="button"
            className="wc-thread-del"
            aria-label="Delete conversation"
            title="Delete"
            onClick={(e) => { e.stopPropagation(); onDeleteLocal(r.id); }}
          >
            &times;
          </button>
        )}
      </div>
    );
  };

  const archivedRows = sectionRows(ARCHIVED);
  const ungroupedRows = sectionRows(UNGROUPED);
  const hasGroups = sidebar.groups.length > 0;
  const peersWithBase = meshNodes.filter((n) => n.openBase);

  return (
    <>
      <div className="wc-sidebar-head">
        <button
          className="wc-sidebar-collapse"
          aria-expanded={listOpen}
          aria-label={listOpen ? "Collapse sessions" : "Expand sessions"}
          title={listOpen ? "Collapse sessions" : "Expand sessions"}
          onClick={onToggleList}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </button>
        <span className="wc-sidebar-title">Sessions</span>
        <div className="wc-new-wrap" ref={newRef}>
          <button className="wc-new" onClick={() => setNewOpen((v) => !v)} title="Start a new conversation" aria-expanded={newOpen}>
            + New
          </button>
          {newOpen && (
            <div className="wc-newmenu" role="menu">
              <button type="button" className="wc-ctx-item" onClick={() => { setNewOpen(false); onNewLocal(); }}>
                <span className="wc-row-dot" style={{ background: self.accentColor || "#6a746b" }} aria-hidden />
                <span className="wc-ctx-label">On {shortNode(self.node) || "this node"}</span>
              </button>
              {peersWithBase.map((n) => (
                <button
                  key={n.node}
                  type="button"
                  className="wc-ctx-item"
                  onClick={() => {
                    setNewOpen(false);
                    window.open(`${n.openBase}/?new=1`, "_blank", "noopener");
                  }}
                >
                  <span className="wc-row-dot" style={{ background: n.accentColor || "#6a746b" }} aria-hidden />
                  <span className="wc-ctx-label">On {shortNode(n.node)}</span>
                </button>
              ))}
              {transports.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  className="wc-ctx-item"
                  onClick={() => { setNewOpen(false); onOpenRemoteShell(t); }}
                >
                  <span className="wc-row-dot wc-row-dot--shell" aria-hidden />
                  <span className="wc-ctx-label">In {t.label || t.name} shell</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div
        className="wc-side-scroll"
        onContextMenu={(e) => {
          // Only the empty canvas - rows stop propagation by handling first.
          if (e.target === e.currentTarget) { e.preventDefault(); listMenu(e.clientX, e.clientY); }
        }}
      >
        {rows.length === 0 && <div className="wc-empty-list">No conversations yet</div>}

        {sidebar.groups.map((g) => {
          const members = sectionRows(g.id);
          return (
            <div key={g.id} onDragOver={onSectionDragOver(g.id)} onDrop={onSectionDrop(g.id)}>
              <button
                type="button"
                className={`wc-group-head${dropHint?.section === g.id && !dropHint.beforeKey ? " wc-group-head--drophint" : ""}`}
                onClick={() => toggleGroup(g.id)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); groupMenu(g, e.clientX, e.clientY); }}
                onTouchStart={pressStart((x, y) => groupMenu(g, x, y))}
                onTouchMove={pressEnd}
                onTouchEnd={pressEnd}
                aria-expanded={!g.collapsed}
              >
                <svg className={`wc-group-chev${g.collapsed ? " wc-group-chev--closed" : ""}`} width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M2.5 3.5 5 6l2.5-2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
                <span className="wc-group-name">{g.name}</span>
                <span className="wc-group-count">{members.length}</span>
              </button>
              {!g.collapsed && members.map(renderRow)}
            </div>
          );
        })}

        <div onDragOver={onSectionDragOver(UNGROUPED)} onDrop={onSectionDrop(UNGROUPED)}>
          {hasGroups && (
            <div className={`wc-group-head wc-group-head--static${dropHint?.section === UNGROUPED && !dropHint.beforeKey ? " wc-group-head--drophint" : ""}`}>
              <span className="wc-group-name">Ungrouped</span>
              <span className="wc-group-count">{ungroupedRows.length}</span>
            </div>
          )}
          {ungroupedRows.map(renderRow)}
        </div>

        {archivedRows.length > 0 && (
          <div onDragOver={onSectionDragOver(ARCHIVED)} onDrop={onSectionDrop(ARCHIVED)}>
            <button
              type="button"
              className={`wc-group-head${dropHint?.section === ARCHIVED && !dropHint.beforeKey ? " wc-group-head--drophint" : ""}`}
              onClick={() => setArchOpen((v) => !v)}
              aria-expanded={archOpen}
            >
              <svg className={`wc-group-chev${archOpen ? "" : " wc-group-chev--closed"}`} width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M2.5 3.5 5 6l2.5-2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
              <span className="wc-group-name">Archived</span>
              <span className="wc-group-count">{archivedRows.length}</span>
            </button>
            {archOpen && archivedRows.map(renderRow)}
          </div>
        )}
      </div>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {prompt && (
        <TextPrompt
          title={prompt.title}
          initial={prompt.initial}
          onSubmit={prompt.onSubmit}
          onClose={() => setPrompt(null)}
        />
      )}
    </>
  );
}
