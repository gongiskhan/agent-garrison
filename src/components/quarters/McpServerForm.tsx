"use client";

import { useEffect, useState } from "react";
import { QuartersDrawer } from "./QuartersDrawer";
import type { SurfaceEditorProps } from "./surfaceEditors";
import type { McpServerConfig, McpTransport } from "@/lib/mcp-writer";

// Parse "KEY=value" lines into a record (env). Blank lines + lines without "="
// are ignored. Whitespace around the key is trimmed; the value is taken verbatim.
function parseKv(text: string, sep: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(sep);
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + sep.length).trim();
    if (key) out[key] = value;
  }
  return out;
}

function kvToText(obj: Record<string, string> | undefined, sep: string): string {
  if (!obj) return "";
  return Object.entries(obj)
    .map(([k, v]) => `${k}${sep}${v}`)
    .join("\n");
}

const FIELD: React.CSSProperties = {
  width: "100%",
  fontSize: 13,
  padding: "7px 10px",
  border: "1px solid var(--rule)",
  background: "white",
  fontFamily: "var(--font-mono), monospace"
};
const LABEL: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, margin: "0 0 5px" };
const ROW: React.CSSProperties = { marginBottom: 14 };

// Create / edit form for one MCP server in ~/.claude/mcp.json. Transport switch
// drives which fields show: stdio (command/args/env) vs http|sse (url/headers).
export function McpServerForm({ rec, onClose, onSaved }: SurfaceEditorProps) {
  const isEdit = !!rec;
  const [name, setName] = useState(rec ? rec.name : "");
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [url, setUrl] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(isEdit);

  useEffect(() => {
    if (!rec) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/quarters/primitive?id=${encodeURIComponent(rec.id)}`);
        const data = await res.json();
        if (!active) return;
        if (!res.ok) throw new Error(data?.error ?? res.statusText);
        const cfg = (data.config ?? {}) as McpServerConfig;
        const t: McpTransport = cfg.type === "http" || cfg.type === "sse" ? cfg.type : cfg.url && !cfg.command ? "http" : "stdio";
        setTransport(t);
        setCommand(typeof cfg.command === "string" ? cfg.command : "");
        setArgsText(Array.isArray(cfg.args) ? cfg.args.join("\n") : "");
        setEnvText(kvToText(cfg.env, "="));
        setUrl(typeof cfg.url === "string" ? cfg.url : "");
        setHeadersText(kvToText(cfg.headers, ": "));
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [rec]);

  const save = async () => {
    setBusy(true);
    setError(null);
    const config: McpServerConfig =
      transport === "stdio"
        ? {
            command,
            args: argsText.split("\n").map((s) => s.trim()).filter(Boolean),
            env: parseKv(envText, "=")
          }
        : { type: transport, url, headers: parseKv(headersText, ": ") };
    const body = isEdit
      ? { action: "mcp.update", name: rec!.name, newName: name.trim(), config }
      : { action: "mcp.add", name: name.trim(), config };
    try {
      const res = await fetch("/api/quarters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) throw new Error(data?.error ?? data?.code ?? res.statusText);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <QuartersDrawer
      title={isEdit ? `Edit MCP server` : "Add MCP server"}
      subtitle="Written to ~/.claude/mcp.json — Garrison owns this file."
      onClose={onClose}
      testId="mcp-form"
      footer={
        <>
          <button type="button" className="btn small ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn small" data-testid="mcp-save" onClick={() => void save()} disabled={busy || loading}>
            {busy ? "Saving…" : isEdit ? "Save changes" : "Add server"}
          </button>
        </>
      }
    >
      {loading ? (
        <p className="ld" style={{ fontSize: 13 }}>Loading…</p>
      ) : (
        <>
          <div style={ROW}>
            <label style={LABEL}>Server name</label>
            <input
              className="text"
              data-testid="mcp-name"
              style={FIELD}
              value={name}
              placeholder="context7"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div style={ROW}>
            <label style={LABEL}>Transport</label>
            <select
              className="text"
              data-testid="mcp-transport"
              style={FIELD}
              value={transport}
              onChange={(e) => setTransport(e.target.value as McpTransport)}
            >
              <option value="stdio">stdio (local command)</option>
              <option value="http">http (remote URL)</option>
              <option value="sse">sse (remote URL)</option>
            </select>
          </div>

          {transport === "stdio" ? (
            <>
              <div style={ROW}>
                <label style={LABEL}>Command</label>
                <input
                  className="text"
                  data-testid="mcp-command"
                  style={FIELD}
                  value={command}
                  placeholder="npx"
                  onChange={(e) => setCommand(e.target.value)}
                />
              </div>
              <div style={ROW}>
                <label style={LABEL}>Args — one per line</label>
                <textarea
                  className="text"
                  data-testid="mcp-args"
                  style={{ ...FIELD, minHeight: 70 }}
                  value={argsText}
                  placeholder={"-y\n@upstash/context7-mcp"}
                  onChange={(e) => setArgsText(e.target.value)}
                />
              </div>
              <div style={ROW}>
                <label style={LABEL}>Environment — KEY=value per line</label>
                <textarea
                  className="text"
                  data-testid="mcp-env"
                  style={{ ...FIELD, minHeight: 60 }}
                  value={envText}
                  placeholder="API_KEY=sk-..."
                  onChange={(e) => setEnvText(e.target.value)}
                />
              </div>
            </>
          ) : (
            <>
              <div style={ROW}>
                <label style={LABEL}>URL</label>
                <input
                  className="text"
                  data-testid="mcp-url"
                  style={FIELD}
                  value={url}
                  placeholder="https://mcp.example.com/sse"
                  onChange={(e) => setUrl(e.target.value)}
                />
              </div>
              <div style={ROW}>
                <label style={LABEL}>Headers — Name: value per line</label>
                <textarea
                  className="text"
                  data-testid="mcp-headers"
                  style={{ ...FIELD, minHeight: 60 }}
                  value={headersText}
                  placeholder="Authorization: Bearer ..."
                  onChange={(e) => setHeadersText(e.target.value)}
                />
              </div>
            </>
          )}

          {error ? (
            <div className="banner alarm" data-testid="mcp-form-error" style={{ marginTop: 4 }}>
              <span className="glyph">!</span>
              <div><p style={{ margin: 0 }}>{error}</p></div>
            </div>
          ) : null}
        </>
      )}
    </QuartersDrawer>
  );
}
