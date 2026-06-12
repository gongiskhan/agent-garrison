import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import type { ChatEvent, ChatTransport, ClaudeStatus, PermissionMode, SlashCommand } from "./transport";

marked.setOptions({ breaks: true, gfm: true });

interface Turn {
  id: string;
  user: string;
  assistant: string;
  streaming: boolean;
}

const MODE_LABELS: Record<PermissionMode, string> = {
  default: "Default",
  acceptEdits: "Accept Edits",
  plan: "Plan",
  bypassPermissions: "Bypass",
  unknown: "—",
};
const SWITCHABLE: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

let uid = 0;
const nextId = () => `t${Date.now()}_${uid++}`;

export interface ClaudeChatProps {
  transport: ChatTransport;
  /** Optional slot rendered at the left of the composer (e.g. voice controls). */
  composerAdornment?: React.ReactNode;
  /** Optional title shown in the header. */
  title?: string;
}

export function ClaudeChat({ transport, composerAdornment, title }: ClaudeChatProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState<ClaudeStatus>({ rows: [], mode: "unknown", contextPct: null, model: null });
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState<"open" | "closed" | "reconnecting">("reconnecting");
  const [screen, setScreen] = useState<string[]>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [input, setInput] = useState("");
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [menuIdx, setMenuIdx] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Reflect the latest assistant text into the most recent turn's assistant slot.
  const applyAssistant = useCallback((text: string) => {
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.assistant === text) return prev;
      const copy = prev.slice();
      copy[copy.length - 1] = { ...last, assistant: text };
      return copy;
    });
  }, []);

  useEffect(() => {
    const off = transport.connect((ev: ChatEvent) => {
      switch (ev.type) {
        case "hello":
          setStatus(ev.status);
          setBusy(ev.busy);
          setScreen(ev.screen ?? []);
          break;
        case "assistant":
          applyAssistant(ev.text);
          break;
        case "status":
          setStatus({ rows: ev.rows, mode: ev.mode, contextPct: ev.contextPct, model: ev.model });
          break;
        case "turn":
          setBusy(ev.active);
          if (!ev.active) {
            setTurns((prev) => prev.map((t, i) => (i === prev.length - 1 ? { ...t, streaming: false } : t)));
          }
          break;
        case "screen":
          setScreen(ev.lines);
          break;
        case "connection":
          setConn(ev.state);
          break;
        case "error":
          // Surface as an assistant note on the latest turn.
          applyAssistant(`_error: ${ev.message}_`);
          break;
      }
    });
    return off;
  }, [transport, applyAssistant]);

  useEffect(() => {
    transport.fetchCommands().then(setCommands).catch(() => setCommands([]));
  }, [transport]);

  // Auto-scroll when pinned to bottom.
  useEffect(() => {
    if (pinnedRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, busy]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const slashQuery = useMemo(() => {
    const m = /^\/([\w:-]*)$/.exec(input.trim());
    return m ? m[1].toLowerCase() : null;
  }, [input]);

  const filtered = useMemo(() => {
    if (slashQuery === null) return [];
    return commands
      .filter((c) => c.name.toLowerCase().includes(slashQuery))
      .sort((a, b) => {
        const ap = a.name.toLowerCase().startsWith(slashQuery) ? 0 : 1;
        const bp = b.name.toLowerCase().startsWith(slashQuery) ? 0 : 1;
        return ap - bp || a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }, [commands, slashQuery]);

  useEffect(() => setMenuIdx(0), [slashQuery]);

  const send = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      setTurns((prev) => [...prev, { id: nextId(), user: t, assistant: "", streaming: true }]);
      setBusy(true);
      pinnedRef.current = true;
      transport.sendMessage(t).catch(() => {});
      setInput("");
    },
    [transport]
  );

  const pickCommand = useCallback(
    (c: SlashCommand) => {
      const next = `/${c.name}${c.argumentHint ? " " : ""}`;
      setInput(next);
      taRef.current?.focus();
    },
    []
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashQuery !== null && filtered.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMenuIdx((i) => Math.min(filtered.length - 1, i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMenuIdx((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          pickCommand(filtered[menuIdx]);
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          // If the input is exactly a slash query with a highlighted command
          // that takes an argument, fill it; otherwise send.
          const exact = filtered.find((c) => `/${c.name}` === input.trim());
          if (!exact && filtered[menuIdx]?.argumentHint) {
            e.preventDefault();
            pickCommand(filtered[menuIdx]);
            return;
          }
        }
      }
      // IME-safe Enter to send (Shift+Enter = newline). On coarse pointers we
      // keep Enter as newline and rely on the Send button.
      const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
      if (e.key === "Enter" && !e.shiftKey && !(e as any).isComposing && !coarse) {
        e.preventDefault();
        send(input);
      }
    },
    [slashQuery, filtered, menuIdx, input, send, pickCommand]
  );

  const onSetMode = useCallback(
    async (mode: PermissionMode) => {
      try {
        const r = await transport.setMode(mode);
        setStatus((s) => ({ ...s, mode: r.mode }));
      } catch {
        /* ignore */
      }
    },
    [transport]
  );

  return (
    <div className="cc-root">
      <header className="cc-header">
        <span className="cc-title">{title ?? "Claude"}</span>
        <span className={`cc-conn cc-conn-${conn}`} title={`connection: ${conn}`} />
        <span className="cc-spacer" />
        {status.model && <span className="cc-model">{status.model}</span>}
        {status.contextPct != null && <span className="cc-ctx">{status.contextPct}% ctx</span>}
        <button className="cc-rawtoggle" onClick={() => setShowRaw((v) => !v)} title="Show raw terminal">
          {showRaw ? "Hide raw" : "Raw"}
        </button>
      </header>

      <div className="cc-scroll" ref={scrollRef} onScroll={onScroll}>
        {turns.length === 0 && <div className="cc-empty">Send a message to start. Type / for commands and skills.</div>}
        {turns.map((t) => (
          <div className="cc-turn" key={t.id}>
            <div className="cc-user">{t.user}</div>
            {(t.assistant || t.streaming) && (
              <div className="cc-assistant">
                <div className="cc-md" dangerouslySetInnerHTML={{ __html: marked.parse(t.assistant || "") as string }} />
                {t.streaming && !t.assistant && <span className="cc-typing">…</span>}
              </div>
            )}
          </div>
        ))}
        {showRaw && (
          <pre className="cc-raw">{screen.join("\n")}</pre>
        )}
      </div>

      <div className="cc-statusstrip" title="Claude Code status line">
        {status.rows.length > 0 ? status.rows.map((r, i) => <div key={i} className="cc-statusrow">{r}</div>) : <div className="cc-statusrow cc-dim">no status</div>}
      </div>

      <div className="cc-modes">
        {SWITCHABLE.map((m) => (
          <button
            key={m}
            className={`cc-mode ${status.mode === m ? "cc-mode-active" : ""}`}
            disabled={status.mode === "unknown"}
            onClick={() => onSetMode(m)}
            title={`Switch to ${MODE_LABELS[m]} mode`}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      <div className="cc-composer">
        {slashQuery !== null && filtered.length > 0 && (
          <div className="cc-slashmenu">
            {filtered.map((c, i) => (
              <button
                key={c.name}
                className={`cc-slashitem ${i === menuIdx ? "cc-slashitem-active" : ""}`}
                onMouseEnter={() => setMenuIdx(i)}
                onClick={() => pickCommand(c)}
              >
                <span className="cc-slashname">/{c.name}<span className={`cc-badge cc-badge-${c.source}`}>{c.source}</span></span>
                <span className="cc-slashdesc">{c.description || c.argumentHint || ""}</span>
              </button>
            ))}
          </div>
        )}
        <div className="cc-composerrow">
          {composerAdornment}
          <textarea
            ref={taRef}
            className="cc-input"
            value={input}
            placeholder="Message Claude…  (/ for commands)"
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {busy ? (
            <button className="cc-stop" onClick={() => transport.interrupt().catch(() => {})} title="Stop (Esc)">
              <span className="cc-stopsq" /> Stop
            </button>
          ) : (
            <button className="cc-send" onClick={() => send(input)} disabled={!input.trim()} title="Send">
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
