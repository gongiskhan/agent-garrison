import type { Metadata, Viewport } from "next";
import { Barlow, Source_Serif_4, JetBrains_Mono } from "next/font/google";
import { currentProfile } from "@/lib/instance-profile";
import "./globals.css";
import { AppShell } from "@/components/chrome/AppShell";
import { ServiceWorkerRegistrar } from "@/components/chrome/ServiceWorkerRegistrar";

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

// The tab title carries the instance so DEV and PROD are tellable apart from
// the tab bar alone — with both open side by side, the chrome inside the page
// (data-instance stripe + sidebar chip below) is invisible from the tab.
export function generateMetadata(): Metadata {
  const profile = currentProfile();
  return {
    ...metadataBase,
    title: profile === "prod" ? "Agent Garrison" : `Agent Garrison · ${profile.toUpperCase()}`
  };
}

const metadataBase: Metadata = {
  applicationName: "Garrison",
  description: "Local-first composer and runner for autonomous Claude Code setups.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Garrison",
    statusBarStyle: "black-translucent"
  },
  other: {
    // `appleWebApp.capable` only emits the apple-prefixed tag; Chrome warns
    // that it is deprecated in favour of the standard name and wants both.
    "mobile-web-app-capable": "yes"
  },
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" }
    ],
    apple: [
      { url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }
    ]
  }
};

export function generateViewport(): Viewport {
  return {
    // Amber chrome on mobile for DEV, the usual green for PROD — the same
    // at-a-glance split as the in-page stripe.
    themeColor: currentProfile() === "prod" ? "#172019" : "#7c5c10",
    width: "device-width",
    initialScale: 1
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      // globals.css keys the DEV/PROD visual split off this attribute: the
      // fixed top stripe and the sidebar instance chip. Server-rendered, so
      // the marker can never disagree with the process actually serving.
      data-instance={currentProfile()}
      className={`${barlow.variable} ${sourceSerif.variable} ${jetBrainsMono.variable}`}
    >
      <body>
        <AppShell>{children}</AppShell>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
