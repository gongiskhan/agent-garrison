"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { useNodeChrome } from "./NodeBadge";
import { useNativeBridge } from "@/components/capture/BridgeGate";
import { isNativeApp, nativeNode, type NodeInfo } from "@/lib/native-bridge";
import { nodeAppOrigin, nodePageUrl, sameNodeOrigin } from "@/lib/node-switch";
import styles from "./NodeSwitcher.module.css";

interface RosterNode {
  id: string;
  name: string;
  accentColor: string;
  tailnetHost: string | null;
  // A tethered node's own published https origin (null on an ordinary node) -
  // nodeAppOrigin()/nodePageUrl() prefer this over deriving one from
  // tailnetHost, since a tethered node has no tailnet interface of its own.
  appOrigin: string | null;
  state: string;
  isSelf: boolean;
}

// The node badge, made a switcher. The badge still says which machine this
// window is; opening it lists the mesh roster and moves this page to the same
// route on another node. In a browser that is a full navigation to the peer's
// tailnet origin. Inside the app the webview is bound to one origin per
// bridge, so the switch goes through GarrisonNode: select the matching record
// and reload - a node the app has not been given a capture token for is shown
// but cannot be chosen from here (it is added on the Capture page).
export function NodeSwitcher() {
  const node = useNodeChrome();
  const native = useNativeBridge();
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  const [roster, setRoster] = useState<RosterNode[] | null>(null);
  const [appNodes, setAppNodes] = useState<NodeInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/mesh/nodes", { cache: "no-store" });
      const body = (await res.json()) as { nodes?: RosterNode[]; error?: string };
      if (!res.ok) throw new Error(body.error === "state-unavailable" ? "state service unreachable" : body.error || `HTTP ${res.status}`);
      setRoster(body.nodes ?? []);
    } catch (err) {
      setRoster([]);
      setError(err instanceof Error ? err.message : String(err));
    }
    if (isNativeApp()) {
      try {
        setAppNodes(await nativeNode.list());
      } catch {
        setAppNodes([]);
      }
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, load]);

  if (!node) return null;

  const appRecordFor = (row: RosterNode) => appNodes?.find((n) => sameNodeOrigin(n.shellOrigin, row.tailnetHost, row.appOrigin)) ?? null;

  const switchTo = async (row: RosterNode) => {
    if (row.isSelf) {
      setOpen(false);
      return;
    }
    const search = typeof window !== "undefined" ? window.location.search : "";
    if (native) {
      const record = appRecordFor(row);
      if (!record) return;
      setBusy(row.id);
      try {
        // The same page on the other node, as in a browser: the path rides the
        // switch and the rebuilt webview lands on it after its first load.
        await nativeNode.select(record.name, `${pathname}${search}`);
        await nativeNode.reload();
      } catch (err) {
        setBusy(null);
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    const url = nodePageUrl(row.tailnetHost, pathname, search, row.appOrigin);
    if (!url) {
      setError(`${row.name} has no tailnet address`);
      return;
    }
    setBusy(row.id);
    window.location.assign(url);
  };

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.badge}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`This node: ${node.name} (${node.id}) - switch node`}
        onClick={() => setOpen((v) => !v)}
        data-testid="node-switcher"
      >
        <span className={styles.dot} aria-hidden />
        <span className={styles.name}>{node.name}</span>
        <ChevronDown size={12} aria-hidden className={styles.chev} />
      </button>
      {open ? (
        <div className={styles.menu} role="listbox" aria-label="Switch node" data-testid="node-switcher-menu">
          {roster === null ? (
            <div className={styles.note}>Loading the mesh roster</div>
          ) : roster.length === 0 ? (
            <div className={styles.note}>{error ? `Roster unavailable: ${error}` : "No other nodes registered"}</div>
          ) : (
            roster.map((row) => {
              const record = native ? appRecordFor(row) : null;
              const reachable = row.isSelf || (native ? Boolean(record) : Boolean(nodeAppOrigin(row.tailnetHost, row.appOrigin)));
              const hint = row.isSelf
                ? "this window"
                : native && !record
                  ? "not added in the app"
                  : !nodeAppOrigin(row.tailnetHost, row.appOrigin)
                    ? "no tailnet address"
                    : row.state;
              return (
                <button
                  key={row.id}
                  type="button"
                  role="option"
                  aria-selected={row.isSelf}
                  className={styles.row}
                  disabled={!reachable || busy !== null}
                  onClick={() => void switchTo(row)}
                  style={{ ["--row-accent" as string]: row.accentColor }}
                >
                  <span className={styles.rowDot} aria-hidden />
                  <span className={styles.rowName}>{row.name}</span>
                  <span className={styles.rowHint}>{busy === row.id ? "switching" : hint}</span>
                </button>
              );
            })
          )}
          {error && roster && roster.length > 0 ? <div className={styles.note}>{error}</div> : null}
          <Link href="/mesh" className={styles.footer} onClick={() => setOpen(false)}>
            Open Mesh
          </Link>
        </div>
      ) : null}
    </div>
  );
}
