import type { Metadata, Viewport } from "next";
import { Barlow, Source_Serif_4, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/chrome/AppShell";
import { ServiceWorkerRegistrar } from "@/components/chrome/ServiceWorkerRegistrar";
import { readNodeIdentity } from "@/lib/node-identity";
import { readBuildSha } from "@/lib/build-info";

const barlow = Barlow({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"]
});

const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
  weight: ["400", "500", "600", "700"]
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
  weight: ["400", "500", "600"]
});

// Metadata and viewport are generated, not static: every window on this mesh
// must announce WHICH node it is. Same sync, module-cached read as the <html>
// element below, so the title, the dock label and the accent can never
// disagree, and no page load depends on another box being reachable.
//
// Deliberately NOT `force-dynamic`: a filesystem read is invisible to Next's
// dynamic-detection, so statically-rendered pages bake this node's name at
// build time. That is correct here - node.json is written by the installer
// before the first build, and changing it (or the accent) is followed by a
// redeploy, which rebuilds. Forcing the whole tree dynamic to avoid a
// restart-scoped staleness would cost every page its static render.
export function generateMetadata(): Metadata {
  const node = readNodeIdentity();
  return {
    title: {
      default: node.name,
      template: `%s · ${node.name}`
    },
    applicationName: node.name,
    description: "Local-first composer and runner for autonomous Claude Code setups.",
    // Served by src/app/manifest.ts, which Next mounts at this exact path.
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      title: node.name,
      statusBarStyle: "black-translucent"
    },
    other: {
      // `appleWebApp.capable` only emits the apple-prefixed tag; Chrome warns
      // that it is deprecated in favour of the standard name and wants both.
      "mobile-web-app-capable": "yes"
    },
    icons: {
      // /icons/node-*.* is the node-branded route (src/app/icons/[file]),
      // which falls back to the shipped generic mark until the installer has
      // run scripts/node-branding.mjs. The names deliberately differ from the
      // files in public/icons: a static public file always wins over a route
      // handler at the same URL, so a `/icons/icon-192.png` route would be
      // dead code.
      icon: [
        { url: "/icons/node.svg", type: "image/svg+xml" },
        { url: "/icons/node-32.png", sizes: "32x32", type: "image/png" },
        { url: "/icons/node-16.png", sizes: "16x16", type: "image/png" }
      ],
      apple: [{ url: "/icons/node-180.png", sizes: "180x180", type: "image/png" }]
    }
  };
}

export function generateViewport(): Viewport {
  return {
    themeColor: readNodeIdentity().accentHex,
    width: "device-width",
    initialScale: 1,
    // The iOS shell app sets contentInset "never" and paints under the notch
    // and home indicator; cover lets env(safe-area-inset-*) report real values.
    viewportFit: "cover"
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const node = readNodeIdentity();
  const buildSha = readBuildSha();
  return (
    <html
      lang="en"
      className={`${barlow.variable} ${sourceSerif.variable} ${jetBrainsMono.variable}`}
      // The node's colour reaches every stylesheet with no client round trip
      // and no FOUC; the data-* pair is how client components (NodeBadge, the
      // sidebar subtitle) learn the name without a fetch, since node-identity
      // reads the filesystem and cannot be bundled for the browser. Same
      // reasoning for data-build-sha: build-info.ts shells out to git, which
      // is server-only.
      data-node-id={node.id}
      data-node-name={node.name}
      data-node-accent={node.accent}
      data-build-sha={buildSha ?? undefined}
      style={
        {
          "--node-accent": node.accentHex,
          "--node-ink": node.accentInk
        } as React.CSSProperties
      }
    >
      <body>
        <AppShell>{children}</AppShell>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
