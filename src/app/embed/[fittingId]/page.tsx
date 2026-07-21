"use client";

import { useEffect, useState } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { resolveViewUrl } from "@/components/fitting-views/browser-view-url";

interface ViewEntry {
  fittingId: string;
  port: number;
  url: string;
  tailnetUrl: string | null;
  pid: number | null;
  startedAt: string | null;
  healthy: boolean;
}

export default function EmbedPage() {
  const params = useParams<{ fittingId: string }>();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const router = useRouter();
  // Derive fittingId from pathname as the source of truth — useParams has been
  // observed returning stale values when navigating between sibling dynamic
  // routes in Next 14, which causes the iframe to keep showing the previous
  // Fitting's content even after the URL changes.
  const fromPath = pathname.startsWith("/embed/")
    ? decodeURIComponent(pathname.slice("/embed/".length).split("/")[0] ?? "")
    : "";
  const fittingId = fromPath || params.fittingId;
  const [entry, setEntry] = useState<ViewEntry | null | undefined>(undefined);

  // Cross-Fitting navigation: an embedded Fitting can ask Garrison to swap to
  // another Fitting (with optional query params forwarded to the destination
  // iframe). Without this, a Fitting calling `window.location.href = otherUrl`
  // would swap its iframe content but leave Garrison's outer URL stale — the
  // sidebar would still highlight the old Fitting and clicking its link would
  // be a no-op.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type !== "garrison:navigate-fitting") return;
      if (typeof data.fittingId !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(data.fittingId)) return;
      const qs = new URLSearchParams(
        data.params && typeof data.params === "object" ? data.params : {}
      ).toString();
      router.push(`/embed/${data.fittingId}${qs ? `?${qs}` : ""}`);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [router]);

  useEffect(() => {
    let alive = true;
    setEntry(undefined);
    async function load() {
      try {
        const res = await fetch("/api/fittings/views", { cache: "no-store" });
        const data = await res.json();
        const found = (data.views as ViewEntry[] | undefined)?.find(
          (v) => v.fittingId === fittingId
        );
        if (alive) setEntry(found ?? null);
      } catch {
        if (alive) setEntry(null);
      }
    }
    void load();
    return () => {
      alive = false;
    };
  }, [fittingId]);

  if (entry === undefined) {
    return (
      <div style={{ padding: 24, color: "var(--mute)" }}>Loading view…</div>
    );
  }
  if (!entry || !entry.url) {
    return (
      <div style={{ padding: 24 }}>
        <h2 style={{ marginTop: 0 }}>{fittingId} is not running</h2>
        <p style={{ color: "var(--mute)" }}>
          Start the operative to launch this view, or open the fitting overview
          to inspect it.
        </p>
      </div>
    );
  }
  const qs = searchParams?.toString() ?? "";
  // Pick the reachable URL for where the browser is: loopback locally, the HTTPS
  // tailnet endpoint over Tailscale (so the iframe isn't unreachable / mixed-content).
  const base = resolveViewUrl(entry);

  // "" means this view is running but has no reachable URL from here — over the
  // tailnet that is a missing `tailscale serve` mapping for its port. Rendering
  // the iframe anyway would request an http:// frame from an https:// page, which
  // the browser blocks as mixed content and shows as a BLANK pane with no
  // explanation. Say what is wrong and how to fix it instead.
  if (!base) {
    return (
      <div style={{ padding: 24 }}>
        <h2 style={{ marginTop: 0 }}>{fittingId} is not published to the tailnet</h2>
        <p style={{ color: "var(--mute)" }}>
          It is running on port {entry.port}, but that port has no{" "}
          <code>tailscale serve</code> mapping, so it cannot be embedded over
          HTTPS (a plain-HTTP frame would be blocked as mixed content).
        </p>
        <p style={{ color: "var(--mute)" }}>
          Publish it by running this from a prod shell on the Garrison host:
        </p>
        <pre style={{ overflowX: "auto" }}>
          <code>node scripts/tailnet-serve-views.mjs</code>
        </pre>
      </div>
    );
  }

  const iframeSrc = qs ? `${base}${base.includes("?") ? "&" : "?"}${qs}` : base;
  return (
    <iframe
      key={fittingId}
      src={iframeSrc}
      title={fittingId}
      // Own-port views run on a different port (a distinct origin), so without
      // an explicit Permissions-Policy delegation the embedded page's
      // navigator.clipboard is blocked — which silently breaks copy in the
      // dev-env terminal. Same for microphone (web-channel push-to-talk:
      // getUserMedia rejects with NotAllowedError before any prompt) and
      // autoplay (read-aloud's auto-play after a turn is not a user gesture).
      allow="clipboard-read; clipboard-write; microphone; autoplay"
      style={{
        width: "100%",
        height: "100vh",
        border: 0,
        display: "block",
        background: "var(--paper)"
      }}
    />
  );
}
