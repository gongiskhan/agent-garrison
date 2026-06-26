"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { FittingViewProps } from "@/components/fitting-views/registry";
import type { ArtifactMeta } from "@/lib/document-store";

interface DocumentResponse {
  meta: ArtifactMeta;
  content: string;
}

export default function DocumentRead({ params }: FittingViewProps) {
  const id = params.id ?? "";
  const [doc, setDoc] = useState<DocumentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/fittings/documents/${id}`);
        const data = (await res.json()) as DocumentResponse | { error: string };
        if (cancelled) return;
        if (!res.ok) throw new Error("error" in data ? data.error : res.statusText);
        setDoc(data as DocumentResponse);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!id) return <Notice title="No document id in URL" />;
  if (error) return <Notice title="Cannot open document" body={error} />;
  if (!doc) return <Notice title="Loading…" />;

  return (
    <div style={{ display: "grid", gap: 18, maxWidth: 760 }}>
      <header style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>
            {doc.meta.title || doc.meta.filename}
          </div>
          <div className="font-mono" style={{ fontSize: 11, color: "var(--mute)" }}>
            updated {formatTime(doc.meta.updated ?? doc.meta.created)}
          </div>
        </div>
        <Link
          href={`/fitting/documents/${id}/edit`}
          style={{
            marginLeft: "auto",
            padding: "5px 12px",
            border: "1px solid var(--ink)",
            background: "var(--ink)",
            color: "white",
            fontSize: 12,
            textDecoration: "none"
          }}
        >
          Edit
        </Link>
      </header>
      <article
        style={{
          border: "1px solid var(--rule)",
          background: "white",
          padding: "20px 26px"
        }}
      >
        <RenderedMarkdown source={doc.content} />
      </article>
    </div>
  );
}

function Notice({ title, body }: { title: string; body?: string }) {
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
      {body ? (
        <div style={{ color: "var(--mute)", fontSize: 13, marginTop: 6 }}>
          {body}
        </div>
      ) : null}
    </div>
  );
}

// A minimal markdown renderer covering the subset the Operative will produce
// (headings, bullets, paragraphs, inline code). This is intentionally not a
// full library — pulling in remark/rehype would balloon the bundle for v1
// when the Operative isn't writing complex markdown anyway.
function RenderedMarkdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div style={{ fontSize: 14, lineHeight: 1.65 }}>
      {blocks.map((block, index) => renderBlock(block, index))}
    </div>
  );
}

interface MdBlock {
  type: "heading" | "paragraph" | "list" | "code";
  level?: number;
  text?: string;
  items?: string[];
}

function parseMarkdown(source: string): MdBlock[] {
  const lines = source.split(/\r?\n/);
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] | null = null;
  let codeFence: string[] | null = null;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", text: paragraph.join(" ").trim() });
    paragraph = [];
  }
  function flushList() {
    if (!list) return;
    blocks.push({ type: "list", items: list });
    list = null;
  }

  for (const line of lines) {
    if (codeFence) {
      if (line.startsWith("```")) {
        blocks.push({ type: "code", text: codeFence.join("\n") });
        codeFence = null;
      } else {
        codeFence.push(line);
      }
      continue;
    }
    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      codeFence = [];
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "heading",
        level: heading[1].length,
        text: heading[2].trim()
      });
      continue;
    }
    const listItem = /^[-*]\s+(.*)$/.exec(line);
    if (listItem) {
      flushParagraph();
      list ??= [];
      list.push(listItem[1].trim());
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  if (codeFence) {
    blocks.push({ type: "code", text: codeFence.join("\n") });
  }
  return blocks;
}

function renderBlock(block: MdBlock, key: number) {
  if (block.type === "heading") {
    const Tag = `h${Math.min(block.level ?? 1, 6)}` as "h1";
    return (
      <Tag
        key={key}
        style={{
          fontSize: headingSize(block.level ?? 1),
          fontWeight: 600,
          margin: "1.4em 0 0.5em"
        }}
      >
        {renderInline(block.text ?? "")}
      </Tag>
    );
  }
  if (block.type === "list") {
    return (
      <ul key={key} style={{ paddingLeft: 20, margin: "0.4em 0" }}>
        {(block.items ?? []).map((item, idx) => (
          <li key={idx}>{renderInline(item)}</li>
        ))}
      </ul>
    );
  }
  if (block.type === "code") {
    return (
      <pre
        key={key}
        style={{
          background: "var(--paper-2)",
          padding: 12,
          fontSize: 12.5,
          overflowX: "auto",
          margin: "0.6em 0"
        }}
      >
        {block.text}
      </pre>
    );
  }
  return (
    <p key={key} style={{ margin: "0.6em 0" }}>
      {renderInline(block.text ?? "")}
    </p>
  );
}

function headingSize(level: number): number {
  if (level === 1) return 22;
  if (level === 2) return 18;
  if (level === 3) return 16;
  return 14;
}

function renderInline(text: string) {
  // Inline code only. Operative-produced markdown doesn't lean on bold/italic.
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={idx}
          style={{
            background: "var(--paper-2)",
            padding: "1px 4px",
            fontSize: "0.92em"
          }}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}

function formatTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
