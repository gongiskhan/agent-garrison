"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAppBar } from "@/components/chrome/AppBar";
import { nodeAppOrigin } from "@/lib/node-switch";
import type { MeshNodeRow, MeshNodesResponse } from "@/lib/mesh/node-row";
import { OPEN_CONVERSATION_MESSAGE, parentRouteFor } from "@/components/talk/open-on-node";

// A conversation another node owns, shown in THIS window (D48). Conversations
// are home-node-owned: the transcript, its live stream and every tool surface
// render from the node that holds it. What this page owns is the WINDOW: it
// frames the peer's chromeless /frame/talk/<id> under this shell's own chrome,
// so opening a peer's conversation is never a new tab (a phone browser has
// nowhere to put one), never a cross-origin top-level load (the Garrison app
// hands those to Safari, a Home Screen install leaves its scope). The frame is
// a sub-frame navigation, which every one of those hosts allows.
//
// The node is named, not addressed: the roster (/api/mesh/nodes) says which
// tailnet host that name has, so a crafted URL can frame nothing but a mesh
// node, and this node's own name lands on the local page instead of a frame.
const NODE_RE = /^[a-z0-9][a-z0-9-]*$/i;

export default function MeshConversationPage() {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const router = useRouter();
  // The route from the pathname, not useParams: sibling dynamic routes have
  // handed back stale params in Next 14 (see /embed/[fittingId]).
  const segments = pathname.startsWith("/mesh/talk/")
    ? pathname.slice("/mesh/talk/".length).split("/").filter(Boolean).map((s) => decodeURIComponent(s))
    : [];
  const node = segments[0] ?? "";
  const conversation = segments[1] ?? "";
  const qs = searchParams?.toString() ?? "";

  const [rows, setRows] = useState<MeshNodeRow[] | null | undefined>(undefined);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(undefined);
    async function load() {
      try {
        const res = await fetch("/api/mesh/nodes", { cache: "no-store" });
        const data = (await res.json()) as Partial<MeshNodesResponse>;
        if (alive) setRows(Array.isArray(data.nodes) ? data.nodes : null);
      } catch {
        if (alive) setRows(null);
      }
    }
    void load();
    return () => {
      alive = false;
    };
  }, [node]);

  const row = rows?.find((r) => r.name === node) ?? null;
  const selfName = rows?.find((r) => r.isSelf)?.name ?? null;
  // Phone: the app bar carries Back (the rail the row came from) and says whose
  // conversation this is; the shell's subtitle is still THIS node.
  useAppBar({ title: `Conversations on ${row?.name ?? node}`, back: true });

  // This node's own conversations are the local page, never a frame of itself.
  useEffect(() => {
    if (!row?.isSelf) return;
    router.replace(`/talk${conversation ? `/${encodeURIComponent(conversation)}` : ""}${qs ? `?${qs}` : ""}`);
  }, [row, conversation, qs, router]);

  const origin = row && !row.isSelf ? nodeAppOrigin(row.tailnetHost, row.appOrigin) : null;

  // A row the FRAMED page cannot open itself: a conversation on a third node, or
  // on this one. It posts the url it would have navigated to; this window maps
  // the node onto its own routes. Only the frame we rendered is heard.
  useEffect(() => {
    if (!origin) return;
    function onMessage(event: MessageEvent) {
      if (event.origin !== origin) return;
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object" || data.type !== OPEN_CONVERSATION_MESSAGE) return;
      if (typeof data.url !== "string") return;
      const route = parentRouteFor(data.url, selfName);
      if (route) router.push(route);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin, selfName, router]);

  if (!NODE_RE.test(node)) {
    return <Notice title="Not a node name">The address names no mesh node.</Notice>;
  }
  if (rows === undefined) {
    return <div style={{ padding: 24, color: "var(--mute)" }}>Finding {node}...</div>;
  }
  if (rows === null) {
    return (
      <Notice title="The mesh roster is unavailable">
        This node cannot reach the state service, so it cannot say where {node} is. Its conversations are still
        on {node} itself.
      </Notice>
    );
  }
  if (!row) {
    return <Notice title={`${node} is not in the mesh`}>No node by that name is registered.</Notice>;
  }
  if (row.isSelf) {
    return <div style={{ padding: 24, color: "var(--mute)" }}>Opening here...</div>;
  }
  if (!origin) {
    return (
      <Notice title={`${node} has no tailnet address`}>
        The roster records no tailnet host for {node}, so its conversations cannot be shown from here.
      </Notice>
    );
  }
  const src = `${origin}/frame/talk${conversation ? `/${encodeURIComponent(conversation)}` : ""}${qs ? `?${qs}` : ""}`;
  return (
    <div className="embed-view">
      {row.state === "offline" ? (
        <p className="mesh-talk-offline" role="status">
          {node} was last seen offline; the conversation loads when it is back.
        </p>
      ) : null}
      <iframe
        ref={frameRef}
        key={`${node}/${conversation}`}
        src={src}
        title={`Conversation on ${node}`}
        // The peer is another origin: without the delegation its page gets no
        // microphone (push-to-talk), no clipboard (copy) and no autoplay
        // (read-aloud after a turn is not a user gesture).
        allow="clipboard-read; clipboard-write; microphone; autoplay"
      />
    </div>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <p style={{ color: "var(--mute)" }}>{children}</p>
    </div>
  );
}
