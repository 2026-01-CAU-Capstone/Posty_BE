/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '1024mb',
    },
  },
};

module.exports = nextConfig;
