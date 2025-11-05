import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  serverExternalPackages: ['puppeteer', 'puppeteer-core'],
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push('puppeteer', 'puppeteer-core');
    }
    return config;
  },
};

export default nextConfig;
