/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return ["/embed/improver", "/embed/improver-nightly", "/fitting/improver/:path*", "/fitting/improver-nightly/:path*"].map((source)=>({source,destination:"/improver",permanent:false}));
  },
  // Gate builds must not share .next/ with a running dev server — a prod build
  // silently breaks the dev server's dynamic routes (friction-log 2026-06-10).
  // Gates set NEXT_DIST_DIR=.next-build; default stays .next for normal use.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    // The Conversations engine (@garrison/talk) and the PTY substrate it drives
    // are plain node modules with native and process-level state; they load
    // from node_modules at runtime rather than through the server bundle.
    serverComponentsExternalPackages: ["js-yaml", "chokidar", "@garrison/talk", "@garrison/claude-pty", "@garrison/state-client"],
  },
};

export default nextConfig;
