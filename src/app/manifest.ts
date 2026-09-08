import type { MetadataRoute } from "next";
import { readNodeIdentity } from "@/lib/node-identity";

// Next mounts this at /manifest.webmanifest - the same path the deleted static
// public/manifest.webmanifest served, so nothing that references it changes.
//
// Each node is already its own origin, so PWA identity is per-origin and the
// only real problem is the dock: four installs all labelled "Garrison" with
// the same icon. short_name + the node-branded icons fix exactly that.
export const dynamic = "force-dynamic";

export default function manifest(): MetadataRoute.Manifest {
  const node = readNodeIdentity();
  return {
    name: `Garrison ${node.name}`,
    short_name: node.name,
    description: "Local-first composer and runner for autonomous Claude Code setups.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#efe8d9",
    theme_color: node.accentHex,
    orientation: "any",
    // The one deep entry worth a long-press shortcut: Conversations is the
    // phone's home in the app, the dashboard is the desktop's.
    shortcuts: [{ name: "Conversations", short_name: "Talk", url: "/talk" }],
    icons: [
      { src: "/icons/node-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/node-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/node-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
}
