import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  serverExternalPackages: ['puppeteer', 'puppeteer-core', 'whatsapp-web.js'],
  turbopack: {},
};

export default nextConfig;
