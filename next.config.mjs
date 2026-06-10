/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Gate builds must not share .next/ with a running dev server — a prod build
  // silently breaks the dev server's dynamic routes (friction-log 2026-06-10).
  // Gates set NEXT_DIST_DIR=.next-build; default stays .next for normal use.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    serverComponentsExternalPackages: ["js-yaml", "chokidar"]
  }
};

export default nextConfig;
