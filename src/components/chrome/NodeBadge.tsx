"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import styles from "./NodeBadge.module.css";

export interface NodeChrome {
  id: string;
  name: string;
}

// src/lib/node-identity.ts reads the filesystem, so it can never be bundled for
// the browser. layout.tsx stamps the identity onto <html> as data-node-* and
// the colour as --node-accent; this hook is the client side's only reader of
// them. It fills in an effect rather than during render because the server has
// already emitted the markup for this client component and a render-time read
// of `document` would be a hydration mismatch.
export function useNodeChrome(): NodeChrome | null {
  const [node, setNode] = useState<NodeChrome | null>(null);
  useEffect(() => {
    const data = document.documentElement.dataset;
    const id = data.nodeId ?? "";
    const name = data.nodeName ?? "";
    if (!id && !name) return;
    setNode({ id: id || name, name: name || id });
  }, []);
  return node;
}

// Which machine this window is. The accent dot is the cue that survives a
// screenshot and a screen recording, where the title bar does not.
export function NodeBadge() {
  const node = useNodeChrome();
  if (!node) return null;
  return (
    <Link
      href="/mesh"
      className={styles.badge}
      title={`This node: ${node.name} (${node.id}) - open Mesh`}
    >
      <span className={styles.dot} aria-hidden />
      <span className={styles.name}>{node.name}</span>
      <span className={styles.meta}>mesh</span>
    </Link>
  );
}
