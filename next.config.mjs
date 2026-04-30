/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ["js-yaml", "chokidar"]
  }
};

export default nextConfig;
