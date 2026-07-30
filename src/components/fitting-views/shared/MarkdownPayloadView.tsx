"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import yaml from "js-yaml";
import { useAppShell } from "@/components/chrome/AppShell";
import type { FittingViewProps } from "../registry";
import {
  EmptyNote,
  SaveBadge,
  SectionLabel,
  cardStyle,
  fetchJson,
  useAutosave
} from "./common";

// The markdown-payload editor behind the shared `garrison:skill` and
// `garrison:prompt` views. Discovers the fitting's markdown payload (skills
// under .apm/skills/<name>/, prompts under .apm/prompts/ and payload/), then
// edits one document at a time: YAML frontmatter as a per-key form, body as
// plain markdown. Autosaved through the confined fitting-file API — the same
// seed files APM installs from, so an edit lands on the next `up`.

interface DiscoveredDoc {
  path: string;
  label: string;
}

interface DirectoryEntry {
  name: string;
  type: "file" | "dir";
}

interface FrontmatterField {
  key: string;
  // Scalar values edit inline; anything structured edits as a YAML fragment.
  kind: "string" | "boolean" | "yaml";
  value: string;
  checked?: boolean;
}

interface ParsedDoc {
  fields: FrontmatterField[];
  body: string;
  hadFrontmatter: boolean;
}

function parseDoc(content: string): ParsedDoc {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) {
    return { fields: [], body: content, hadFrontmatter: false };
  }
  const body = content.slice(match[0].length);
  let data: unknown;
  try {
    data = yaml.load(match[1]);
  } catch {
    data = null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    // Unparseable or non-map frontmatter: fall back to editing it raw as one
    // YAML field so nothing is silently dropped.
    return {
      fields: [{ key: "", kind: "yaml", value: match[1] }],
      body,
      hadFrontmatter: true
    };
  }
  const fields: FrontmatterField[] = Object.entries(data as Record<string, unknown>).map(
    ([key, value]) => {
      if (typeof value === "boolean") {
        return { key, kind: "boolean" as const, value: "", checked: value };
      }
      if (typeof value === "string" && !value.includes("\n")) {
        return { key, kind: "string" as const, value };
      }
      if (typeof value === "number") {
        return { key, kind: "string" as const, value: String(value) };
      }
      return { key, kind: "yaml" as const, value: yaml.dump(value).trimEnd() };
    }
  );
  return { fields, body, hadFrontmatter: true };
}

function composeDoc(doc: ParsedDoc): string {
  if (!doc.hadFrontmatter && doc.fields.length === 0) {
    return doc.body;
  }
  const lines: string[] = [];
  for (const field of doc.fields) {
    if (field.key === "") {
      // Raw-frontmatter fallback: the value IS the whole block.
      lines.push(field.value.trimEnd());
      continue;
    }
    if (field.kind === "boolean") {
      lines.push(`${field.key}: ${field.checked === true}`);
    } else if (field.kind === "yaml") {
      let parsed: unknown;
      try {
        parsed = yaml.load(field.value);
      } catch {
        parsed = field.value;
      }
      lines.push(yaml.dump({ [field.key]: parsed }).trimEnd());
    } else {
      // A number-looking string stays what the YAML parser makes of it —
      // frontmatter consumers (Claude Code) re-parse it anyway.
      lines.push(yaml.dump({ [field.key]: coerceScalar(field.value) }).trimEnd());
    }
  }
  return `---\n${lines.join("\n")}\n---\n${doc.body}`;
}

function coerceScalar(value: string): unknown {
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d*\.\d+$/.test(value)) return parseFloat(value);
  return value;
}

async function discoverDocs(
  fittingId: string,
  roots: Array<{ dir: string; perDoc: "subdir" | "file" }>
): Promise<DiscoveredDoc[]> {
  const docs: DiscoveredDoc[] = [];
  for (const root of roots) {
    let listing: { entries: DirectoryEntry[] };
    try {
      listing = await fetchJson(`/api/fittings/${fittingId}/files?path=${encodeURIComponent(root.dir)}`);
    } catch {
      continue; // root absent in this fitting
    }
    for (const entry of listing.entries) {
      if (root.perDoc === "subdir" && entry.type === "dir") {
        // A skill dir's document is its SKILL.md.
        docs.push({ path: `${root.dir}/${entry.name}/SKILL.md`, label: entry.name });
      } else if (root.perDoc === "file" && entry.type === "file" && entry.name.endsWith(".md")) {
        docs.push({ path: `${root.dir}/${entry.name}`, label: entry.name.replace(/\.md$/, "") });
      }
    }
  }
  return docs;
}

export function MarkdownPayloadView({
  entry,
  kindLabel,
  roots
}: FittingViewProps & {
  kindLabel: string;
  roots: Array<{ dir: string; perDoc: "subdir" | "file" }>;
}) {
  const { openFittingEditor } = useAppShell();
  const fittingId = entry.id;
  const [docs, setDocs] = useState<DiscoveredDoc[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<ParsedDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const { state, error, schedule, flushNow } = useAutosave<ParsedDoc>(async (value) => {
    if (!selected) return;
    await fetchJson(`/api/fittings/${fittingId}/file`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: selected, content: composeDoc(value) })
    });
  });

  useEffect(() => {
    let cancelled = false;
    void discoverDocs(fittingId, roots)
      .then((found) => {
        if (cancelled) return;
        setDocs(found);
        setSelected((prev) => prev ?? found[0]?.path ?? null);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fittingId]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setDoc(null);
    setLoadError(null);
    void fetchJson<{ content: string; encoding: string }>(
      `/api/fittings/${fittingId}/file?path=${encodeURIComponent(selected)}`
    )
      .then((file) => {
        if (cancelled) return;
        if (file.encoding !== "utf8") {
          setLoadError("This document is not editable text.");
          return;
        }
        setDoc(parseDoc(file.content));
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [fittingId, selected]);

  const update = useCallback(
    (next: ParsedDoc) => {
      setDoc(next);
      schedule(next);
    },
    [schedule]
  );

  const multiDoc = (docs?.length ?? 0) > 1;
  const selectedLabel = useMemo(
    () => docs?.find((d) => d.path === selected)?.label ?? selected,
    [docs, selected]
  );

  if (docs === null && !loadError) {
    return <EmptyNote>Reading {kindLabel} payload…</EmptyNote>;
  }
  if (docs !== null && docs.length === 0) {
    return (
      <EmptyNote>
        No {kindLabel} documents found in this Fitting. Open its files from the Muster to add one.
      </EmptyNote>
    );
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {multiDoc ? (
          <select
            className="text"
            aria-label={`Select ${kindLabel}`}
            value={selected ?? ""}
            onChange={(e) => setSelected(e.target.value)}
            style={{ maxWidth: 320 }}
          >
            {docs?.map((d) => (
              <option key={d.path} value={d.path}>
                {d.label}
              </option>
            ))}
          </select>
        ) : (
          <b style={{ fontSize: 13.5 }}>{selectedLabel}</b>
        )}
        <code className="font-mono" style={{ fontSize: 11, color: "var(--mute)" }}>
          {selected}
        </code>
        <span style={{ flex: 1 }} />
        <SaveBadge state={state} error={error} />
        <button
          type="button"
          className="btn small ghost active:translate-y-px"
          onClick={() => openFittingEditor(entry)}
          title="Open the full file editor for this Fitting"
        >
          All files
        </button>
      </div>

      {loadError ? (
        <EmptyNote>{loadError}</EmptyNote>
      ) : doc === null ? (
        <EmptyNote>Loading document…</EmptyNote>
      ) : (
        <>
          {doc.fields.length > 0 ? (
            <section style={cardStyle}>
              <SectionLabel>Frontmatter</SectionLabel>
              <div style={{ display: "grid", gap: 10 }}>
                {doc.fields.map((field, index) => (
                  <div key={`${field.key}-${index}`} style={{ display: "grid", gap: 4 }}>
                    <label
                      className="font-mono"
                      htmlFor={`fm-${fittingId}-${index}`}
                      style={{ fontSize: 11.5, color: "var(--ink)" }}
                    >
                      {field.key || "frontmatter"}
                    </label>
                    {field.kind === "boolean" ? (
                      <input
                        id={`fm-${fittingId}-${index}`}
                        type="checkbox"
                        checked={field.checked === true}
                        onChange={(e) =>
                          update({
                            ...doc,
                            fields: doc.fields.map((f, i) =>
                              i === index ? { ...f, checked: e.target.checked } : f
                            )
                          })
                        }
                        style={{ justifySelf: "start", width: 15, height: 15 }}
                      />
                    ) : field.kind === "yaml" ? (
                      <textarea
                        id={`fm-${fittingId}-${index}`}
                        className="text font-mono"
                        rows={Math.min(8, Math.max(2, field.value.split("\n").length))}
                        value={field.value}
                        onChange={(e) =>
                          update({
                            ...doc,
                            fields: doc.fields.map((f, i) =>
                              i === index ? { ...f, value: e.target.value } : f
                            )
                          })
                        }
                        onBlur={flushNow}
                        style={{ fontSize: 12, lineHeight: 1.55 }}
                      />
                    ) : (
                      <input
                        id={`fm-${fittingId}-${index}`}
                        className="text"
                        type="text"
                        value={field.value}
                        onChange={(e) =>
                          update({
                            ...doc,
                            fields: doc.fields.map((f, i) =>
                              i === index ? { ...f, value: e.target.value } : f
                            )
                          })
                        }
                        onBlur={flushNow}
                      />
                    )}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section style={cardStyle}>
            <SectionLabel>{doc.fields.length > 0 ? "Body" : "Document"}</SectionLabel>
            <textarea
              className="text font-mono"
              aria-label={`${kindLabel} body`}
              value={doc.body}
              onChange={(e) => update({ ...doc, body: e.target.value })}
              onBlur={flushNow}
              rows={Math.min(34, Math.max(12, doc.body.split("\n").length + 2))}
              style={{ width: "100%", fontSize: 12.5, lineHeight: 1.6, resize: "vertical" }}
            />
          </section>
        </>
      )}
    </div>
  );
}
