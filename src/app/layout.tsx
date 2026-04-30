import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Garrison",
  description: "Local-first composer and runner for autonomous agent setups.",
  icons: {
    icon: "/icon.svg"
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
