// Who this machine is in the mesh.
//
// `$GARRISON_HOME/node.json` is AUTHORITATIVE and node-local. The state
// service's node registry holds a pushed replica for peer discovery, never the
// source: the root layout renders this node's name and colour on every page
// load, and a control plane whose own title bar depends on another box being
// reachable is not a control plane. Identity belongs in the same node-local
// column as ports, bind host and transports.
//
// Reads are SYNC and module-cached (the shape src/lib/dev-root.ts:41 uses), so
// `generateMetadata`, `generateViewport` and server components can call this
// with no await. The cache is keyed on the resolved Garrison home, so a test
// that repoints GARRISON_HOME gets a fresh read without import-order tricks;
// `resetNodeIdentityCache()` forces one regardless.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { garrisonDir } from "./claude-home";

export interface NodeAccent {
  // Stable palette key. This - not a hex string - is what node.json stores.
  id: string;
  hex: string;
  // Text/glyph colour to paint ON the accent (>= 4.5:1 against it).
  ink: string;
}

// Eight fixed accents, no free-form colour picker: a picker that lets you
// choose two near-identical greens defeats the entire point of colouring a
// node. Muted and in the same register as Garrison's sage/brass palette.
//
// Every entry clears 3:1 against BOTH the light paper surfaces (--canvas
// #efe8d9, --surface #f7f2e8, --surface-raised #fffaf0) and the dark shell
// surfaces (--shell #172019, --shell-2 #1e2a22), and 4.5:1 against white, so
// the same hex works as a dot, a rule, a fill behind `ink`, and a theme colour.
// Measured (canvas / shell / shell-2 / white):
//   moss   3.92 3.49 3.11 4.78      rose   3.74 3.66 3.27 4.56
//   fern   3.70 3.70 3.30 4.51      plum   3.70 3.70 3.30 4.51
//   brass  3.70 3.70 3.30 4.52      violet 3.93 3.49 3.11 4.79
//   copper 3.70 3.70 3.30 4.51      steel  3.70 3.70 3.30 4.52
// tests/node-identity.test.ts recomputes these, so an edit here that breaks
// contrast fails the suite rather than shipping an unreadable node.
export const NODE_ACCENTS: readonly NodeAccent[] = [
  { id: "moss", hex: "#4a7d5f", ink: "#ffffff" },
  { id: "fern", hex: "#478529", ink: "#ffffff" },
  { id: "brass", hex: "#85763a", ink: "#ffffff" },
  { id: "copper", hex: "#a26949", ink: "#ffffff" },
  { id: "rose", hex: "#a7626b", ink: "#ffffff" },
  { id: "plum", hex: "#af5895", ink: "#ffffff" },
  { id: "violet", hex: "#8a62a7", ink: "#ffffff" },
  { id: "steel", hex: "#527c91", ink: "#ffffff" }
];

export interface NodeIdentity {
  // Sanitised, mesh-wide unique. Matches /^[a-z0-9][a-z0-9-]*$/.
  id: string;
  // Human label shown in the tab title, the dock and the sidebar.
  name: string;
  // Palette key; `accentHex` / `accentInk` are the resolved colours.
  accent: string;
  accentHex: string;
  accentInk: string;
  // FQDN this node is reachable at on the tailnet, when the installer knew it.
  tailnetHost: string | null;
  createdAt: string | null;
  // Mesh (2026-09): a TETHERED node (csg) has no tailscale interface of its
  // own - it reaches the mesh through its owner's reverse tunnel instead, so
  // it needs its browser-facing origins spelled out rather than derived from
  // tailnetHost. `tethered` is present (true) only on such a node; every
  // other node leaves it undefined. `tetherHost` names the owner node.
  tethered?: true;
  tetherHost: string | null;
  // Full https origins a browser can reach this node's app / Shells fitting
  // at - the tether's published tailnet serve URLs on the OWNER's host, not
  // this node's own address (it has none reachable from outside the tether).
  // https only: an http origin would be mixed content on the shell's https
  // page, so a non-https value here is treated as absent (null), never
  // passed through.
  appOrigin: string | null;
  shellOrigin: string | null;
  // "file" once the installer has run; "fallback" for a checkout that never
  // did. A fallback node is still visually distinct - four identical
  // "Agent Garrison" windows is the failure this whole module exists to avoid.
  source: "file" | "fallback";
}

// https only - an http value is mixed content on the (always-https) shell
// page, so it is treated as absent rather than passed through to a client.
function httpsOriginOrNull(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" ? raw.trim().replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

export function nodeIdentityPath(home: string = garrisonDir()): string {
  return path.join(home, "node.json");
}

// The dir `scripts/node-branding.mjs` writes and /icons/[file] serves from.
export function nodeBrandingDir(home: string = garrisonDir()): string {
  return path.join(home, "branding");
}

// Lowercase, [a-z0-9-] only, collapsed and trimmed, first DNS label only (a
// macOS hostname arrives as "mac-pro.local"), capped at 63 chars. Returns null
// when nothing survives, so callers decide the fallback rather than inheriting
// an empty string.
export function sanitizeNodeId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.trim().toLowerCase().split(".")[0] ?? "";
  const cleaned = label
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return cleaned || null;
}

// FNV-1a. Any stable hash does; this one is short, dependency-free and gives a
// well-spread low byte, which is all `% NODE_ACCENTS.length` needs.
function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// The accent a node gets when nobody chose one. Deterministic per id, so the
// same machine keeps the same colour across reinstalls and every peer that
// only knows the id can draw the right dot.
export function accentForNodeId(id: string): NodeAccent {
  return NODE_ACCENTS[hashString(id) % NODE_ACCENTS.length];
}

// Accept a palette key, a palette index, or a hex that IS one of the palette
// entries. Anything else - including a free-form hex - falls back to the
// id-derived accent: the palette is closed on purpose.
export function resolveAccent(value: unknown, id: string): NodeAccent {
  if (typeof value === "number" && Number.isInteger(value)) {
    const entry = NODE_ACCENTS[value];
    if (entry) return entry;
  }
  if (typeof value === "string") {
    const key = value.trim().toLowerCase();
    const byId = NODE_ACCENTS.find((a) => a.id === key);
    if (byId) return byId;
    const byHex = NODE_ACCENTS.find((a) => a.hex === key);
    if (byHex) return byHex;
  }
  return accentForNodeId(id);
}

function fallbackIdentity(): NodeIdentity {
  const id = sanitizeNodeId(os.hostname()) ?? "node";
  const accent = accentForNodeId(id);
  return {
    id,
    name: id,
    accent: accent.id,
    accentHex: accent.hex,
    accentInk: accent.ink,
    tailnetHost: null,
    createdAt: null,
    tetherHost: null,
    appOrigin: null,
    shellOrigin: null,
    source: "fallback"
  };
}

function parseIdentity(raw: string): NodeIdentity | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const rec = doc as Record<string, unknown>;
  const id = sanitizeNodeId(rec.id);
  if (!id) return null; // a node.json with no usable id is no better than none
  const accent = resolveAccent(rec.accent, id);
  const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id;
  const tailnetHost =
    typeof rec.tailnetHost === "string" && rec.tailnetHost.trim()
      ? rec.tailnetHost.trim()
      : null;
  const createdAt =
    typeof rec.createdAt === "string" && rec.createdAt.trim() ? rec.createdAt.trim() : null;
  const tetherHost =
    typeof rec.tetherHost === "string" && rec.tetherHost.trim() ? rec.tetherHost.trim() : null;
  return {
    id,
    name,
    accent: accent.id,
    accentHex: accent.hex,
    accentInk: accent.ink,
    tailnetHost,
    createdAt,
    ...(rec.tethered === true ? { tethered: true as const } : {}),
    tetherHost,
    appOrigin: httpsOriginOrNull(rec.appOrigin),
    shellOrigin: httpsOriginOrNull(rec.shellOrigin),
    source: "file"
  };
}

let cache: { home: string; identity: NodeIdentity } | null = null;

export function resetNodeIdentityCache(): void {
  cache = null;
}

// This node's identity. Never throws: an absent, unreadable or malformed
// node.json degrades to the hostname-derived fallback.
export function readNodeIdentity(): NodeIdentity {
  const home = garrisonDir();
  if (cache && cache.home === home) return cache.identity;
  let identity: NodeIdentity | null = null;
  try {
    identity = parseIdentity(fs.readFileSync(nodeIdentityPath(home), "utf8"));
  } catch {
    /* no file / unreadable -> fallback */
  }
  const resolved = identity ?? fallbackIdentity();
  cache = { home, identity: resolved };
  return resolved;
}

// One or two uppercase characters for the icon monogram: initials when the name
// has two or more words, otherwise its first two alphanumerics. Never longer
// than two, so the icon band's glyph stays legible when the icon is scaled down.
export function nodeMonogram(name: string): string {
  const words = String(name ?? "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  const single = (words[0] ?? "").toUpperCase();
  if (single.length >= 2) return single.slice(0, 2);
  if (single.length === 1) return single;
  return "GN"; // Garrison Node - only reachable if the name is punctuation-only
}
