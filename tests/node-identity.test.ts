// Node identity: $GARRISON_HOME/node.json is authoritative, the hostname is the
// fallback, and the accent palette is closed and contrast-checked.
//
// Hermetic: GARRISON_HOME is repointed at a tmp dir per case and the module
// cache is reset, so nothing here reads or depends on the real ~/.garrison.
// readNodeIdentity() caches per resolved home, which is exactly the trap
// tests/board-summary.test.ts documents - hence both the env pin and the
// explicit reset.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import {
  NODE_ACCENTS,
  accentForNodeId,
  nodeBrandingDir,
  nodeIdentityPath,
  nodeMonogram,
  readNodeIdentity,
  resetNodeIdentityCache,
  resolveAccent,
  sanitizeNodeId
} from "../src/lib/node-identity";

const ORIGINAL_HOME = process.env.GARRISON_HOME;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "node-identity-"));
  process.env.GARRISON_HOME = home;
  resetNodeIdentityCache();
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = ORIGINAL_HOME;
  resetNodeIdentityCache();
});

function writeNodeJson(doc: unknown): void {
  writeFileSync(
    nodeIdentityPath(home),
    typeof doc === "string" ? doc : JSON.stringify(doc)
  );
}

// WCAG relative luminance / contrast ratio, so the palette's claim is measured
// rather than asserted.
function luminance(hex: string): number {
  const channel = (n: number) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("NODE_ACCENTS", () => {
  it("is a closed palette of 8 unique, well-formed entries", () => {
    expect(NODE_ACCENTS).toHaveLength(8);
    expect(new Set(NODE_ACCENTS.map((a) => a.id)).size).toBe(8);
    expect(new Set(NODE_ACCENTS.map((a) => a.hex)).size).toBe(8);
    for (const accent of NODE_ACCENTS) {
      expect(accent.id).toMatch(/^[a-z]+$/);
      expect(accent.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(accent.ink).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("reads on both the light paper surfaces and the dark shell surfaces", () => {
    // globals.css: --canvas / --surface / --surface-raised are the light
    // grounds; --shell / --shell-2 are the dark ones. 3:1 is the WCAG floor
    // for a non-text UI element (the dot, the rule, the badge border).
    const light = ["#efe8d9", "#f7f2e8", "#fffaf0"];
    const dark = ["#172019", "#1e2a22"];
    for (const accent of NODE_ACCENTS) {
      for (const ground of [...light, ...dark]) {
        expect(
          contrast(accent.hex, ground),
          `${accent.id} on ${ground}`
        ).toBeGreaterThanOrEqual(3);
      }
      // `ink` is painted ON the accent (the icon monogram), so it needs the
      // 4.5:1 text floor.
      expect(contrast(accent.hex, accent.ink), `${accent.id} ink`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("accentForNodeId", () => {
  it("is deterministic and spread across the palette", () => {
    expect(accentForNodeId("dev-madrid")).toEqual(accentForNodeId("dev-madrid"));
    expect(accentForNodeId("dev-madrid").id).toBe(accentForNodeId("dev-madrid").id);
    const ids = ["dev-madrid", "mac-pro", "mac-mini", "macbook-air"].map(
      (id) => accentForNodeId(id).id
    );
    // Not a guarantee of the algorithm, but a regression tripwire: the four
    // real nodes must not collide onto one colour.
    expect(new Set(ids).size).toBeGreaterThan(1);
    for (const id of ids) expect(NODE_ACCENTS.some((a) => a.id === id)).toBe(true);
  });
});

describe("resolveAccent", () => {
  it("accepts a palette key, an index, or a palette hex", () => {
    expect(resolveAccent("copper", "x").id).toBe("copper");
    expect(resolveAccent("COPPER", "x").id).toBe("copper");
    expect(resolveAccent(3, "x")).toEqual(NODE_ACCENTS[3]);
    expect(resolveAccent("#527c91", "x").id).toBe("steel");
  });

  it("refuses a free-form colour and falls back to the id-derived accent", () => {
    // The palette is closed on purpose: a picker that lets you choose two
    // near-identical greens defeats the point of colouring a node.
    expect(resolveAccent("#ff00ff", "mac-pro")).toEqual(accentForNodeId("mac-pro"));
    expect(resolveAccent("chartreuse", "mac-pro")).toEqual(accentForNodeId("mac-pro"));
    expect(resolveAccent(99, "mac-pro")).toEqual(accentForNodeId("mac-pro"));
    expect(resolveAccent(undefined, "mac-pro")).toEqual(accentForNodeId("mac-pro"));
  });
});

describe("sanitizeNodeId", () => {
  it("lowercases, keeps the first DNS label, and strips junk", () => {
    expect(sanitizeNodeId("Mac-Pro.local")).toBe("mac-pro");
    expect(sanitizeNodeId("Gonçalo's MacBook Air")).toBe("gon-alo-s-macbook-air");
    expect(sanitizeNodeId("  DEV-MADRID  ")).toBe("dev-madrid");
    expect(sanitizeNodeId("--")).toBeNull();
    expect(sanitizeNodeId("")).toBeNull();
    expect(sanitizeNodeId(42)).toBeNull();
    expect(sanitizeNodeId("x".repeat(80))?.length).toBe(63);
  });
});

describe("nodeMonogram", () => {
  it("is one or two uppercase characters", () => {
    expect(nodeMonogram("Pro")).toBe("PR");
    expect(nodeMonogram("dev madrid")).toBe("DM");
    expect(nodeMonogram("mac-mini")).toBe("MM");
    expect(nodeMonogram("X")).toBe("X");
    expect(nodeMonogram("...")).toBe("GN");
  });
});

describe("readNodeIdentity", () => {
  it("falls back to the hostname when node.json is absent", () => {
    const expectedId = sanitizeNodeId(hostname()) ?? "node";
    const identity = readNodeIdentity();
    expect(identity.source).toBe("fallback");
    expect(identity.id).toBe(expectedId);
    expect(identity.name).toBe(expectedId);
    expect(identity.accent).toBe(accentForNodeId(expectedId).id);
    expect(identity.accentHex).toBe(accentForNodeId(expectedId).hex);
    expect(identity.tailnetHost).toBeNull();
  });

  it("reads node.json when it is present", () => {
    writeNodeJson({
      id: "mac-pro",
      name: "Pro",
      accent: "copper",
      tailnetHost: "mac-pro.tail31efa.ts.net",
      createdAt: "2026-08-25T09:00:00Z"
    });
    resetNodeIdentityCache();
    expect(readNodeIdentity()).toEqual({
      id: "mac-pro",
      name: "Pro",
      accent: "copper",
      accentHex: "#a26949",
      accentInk: "#ffffff",
      tailnetHost: "mac-pro.tail31efa.ts.net",
      createdAt: "2026-08-25T09:00:00Z",
      tetherHost: null,
      appOrigin: null,
      shellOrigin: null,
      source: "file"
    });
  });

  it("reads a tethered node's fields - tethered/tetherHost, and https-only origins", () => {
    writeNodeJson({
      id: "csg",
      name: "csg",
      tethered: true,
      tetherHost: "dev-madrid",
      appOrigin: "https://dev-madrid.tail31efa.ts.net:8977",
      shellOrigin: "https://dev-madrid.tail31efa.ts.net:8998/"
    });
    resetNodeIdentityCache();
    const identity = readNodeIdentity();
    expect(identity.tethered).toBe(true);
    expect(identity.tetherHost).toBe("dev-madrid");
    expect(identity.appOrigin).toBe("https://dev-madrid.tail31efa.ts.net:8977");
    // a trailing slash is stripped, so peers can string-concatenate a path onto it
    expect(identity.shellOrigin).toBe("https://dev-madrid.tail31efa.ts.net:8998");
  });

  it("treats a non-https appOrigin/shellOrigin as absent (mixed content on an https page)", () => {
    writeNodeJson({ id: "csg", appOrigin: "http://dev-madrid.tail31efa.ts.net:8977", shellOrigin: "not a url" });
    resetNodeIdentityCache();
    const identity = readNodeIdentity();
    expect(identity.appOrigin).toBeNull();
    expect(identity.shellOrigin).toBeNull();
  });

  it("omits `tethered` entirely (not false) on an ordinary node", () => {
    writeNodeJson({ id: "dev-madrid" });
    resetNodeIdentityCache();
    expect("tethered" in readNodeIdentity()).toBe(false);
  });

  it("degrades to the fallback on malformed JSON or a missing id", () => {
    writeNodeJson("{ not json");
    resetNodeIdentityCache();
    expect(readNodeIdentity().source).toBe("fallback");

    writeNodeJson({ name: "Pro", accent: "copper" });
    resetNodeIdentityCache();
    expect(readNodeIdentity().source).toBe("fallback");
  });

  it("defaults the name to the id and derives the accent when unset", () => {
    writeNodeJson({ id: "Mac-Mini.local" });
    resetNodeIdentityCache();
    const identity = readNodeIdentity();
    expect(identity.id).toBe("mac-mini");
    expect(identity.name).toBe("mac-mini");
    expect(identity.accent).toBe(accentForNodeId("mac-mini").id);
  });

  it("caches until reset, and re-reads when GARRISON_HOME moves", () => {
    writeNodeJson({ id: "mac-pro", name: "Pro", accent: "copper" });
    resetNodeIdentityCache();
    expect(readNodeIdentity().name).toBe("Pro");

    // A write behind the cache is invisible...
    writeNodeJson({ id: "mac-pro", name: "Renamed", accent: "copper" });
    expect(readNodeIdentity().name).toBe("Pro");
    // ...until the cache is dropped.
    resetNodeIdentityCache();
    expect(readNodeIdentity().name).toBe("Renamed");

    // A different home is a different cache key, no reset needed.
    const other = mkdtempSync(join(tmpdir(), "node-identity-other-"));
    writeFileSync(nodeIdentityPath(other), JSON.stringify({ id: "mac-mini", name: "Mini" }));
    process.env.GARRISON_HOME = other;
    expect(readNodeIdentity().name).toBe("Mini");
  });

  it("resolves the branding dir under the Garrison home", () => {
    expect(nodeBrandingDir()).toBe(join(home, "branding"));
    expect(nodeIdentityPath()).toBe(join(home, "node.json"));
  });
});

describe("scripts/node-branding.mjs", () => {
  it("carries the same palette and monogram rules as the TS module", async () => {
    // The script must run standalone under plain `node`, which cannot import
    // TypeScript, so the palette is duplicated there. This is what stops the
    // two copies drifting into a node whose icon and UI disagree.
    const branding = await import("../scripts/node-branding.mjs");
    expect(branding.NODE_ACCENTS).toEqual(NODE_ACCENTS);
    for (const name of ["Pro", "dev madrid", "mac-mini", "X", "..."]) {
      expect(branding.nodeMonogram(name)).toBe(nodeMonogram(name));
    }
    expect(branding.sanitizeNodeId("Mac-Pro.local")).toBe(sanitizeNodeId("Mac-Pro.local"));
    expect(branding.accentForNodeId("dev-madrid")).toEqual(accentForNodeId("dev-madrid"));
  });

  it("injects the node band before </svg> without touching the shipped mark", async () => {
    const branding = await import("../scripts/node-branding.mjs");
    const source = '<svg viewBox="0 0 512 512" width="512" height="512"><rect/></svg>';
    const out = branding.bandedSvg(source, {
      hex: "#a26949",
      ink: "#ffffff",
      monogram: "PR"
    });
    expect(out.startsWith('<svg viewBox="0 0 512 512" width="512" height="512"><rect/>')).toBe(true);
    expect(out.trimEnd().endsWith("</svg>")).toBe(true);
    expect(out).toContain('fill="#a26949"');
    expect(out).toContain(">PR</text>");
    expect(out.indexOf("node-band")).toBeLessThan(out.lastIndexOf("</svg>"));
  });

  it("asks for every icon size the layout and manifest reference", async () => {
    const branding = await import("../scripts/node-branding.mjs");
    const files = branding.ICON_SIZES.map((entry) => entry.file);
    expect(files).toEqual([
      "node-512.png",
      "node-192.png",
      "node-180.png",
      "node-32.png",
      "node-16.png"
    ]);
  });
});

describe("GET /icons/[file]", () => {
  it("serves the shipped mark and refuses anything off the allow-list", async () => {
    const { GET } = await import("../src/app/icons/[file]/route");
    const req = new Request("http://127.0.0.1/icons/node.svg");

    const ok = await GET(req, { params: { file: "node.svg" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/svg+xml");
    expect(await ok.text()).toContain("<svg");

    for (const bad of [
      "../../../etc/passwd",
      "..%2fnode.svg",
      "node.svg/../secret",
      "Node.SVG",
      "node.js",
      ".env",
      "node.png.txt"
    ]) {
      const res = await GET(req, { params: { file: bad } });
      expect(res.status, bad).toBe(404);
    }
  });

  it("prefers this node's branded file over the shipped fallback", async () => {
    const { GET } = await import("../src/app/icons/[file]/route");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(nodeBrandingDir(), { recursive: true });
    writeFileSync(join(nodeBrandingDir(), "node.svg"), "<svg>branded</svg>");
    const res = await GET(new Request("http://127.0.0.1/icons/node.svg"), {
      params: { file: "node.svg" }
    });
    expect(await res.text()).toBe("<svg>branded</svg>");
  });
});
