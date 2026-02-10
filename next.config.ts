import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Enable standalone output for Lambda deployment
  output: 'standalone',

  // Empty turbopack config to silence Next.js 16 warning
  turbopack: {},

  // Ignore linting and type checking during build to resolve environment issues
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },

  // Experimental features
  // experimental: {
  //   // Enable server actions
  //   serverActions: {
  //     bodySizeLimit: '10mb',
  //   },
  // },

  // Image optimization settings
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.amazonaws.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'mitt.hringekjan.is',
        pathname: '/**',
      },
    ],
  },

  // Webpack configuration for Sharp and AWS SDK
  // webpack: (config, { isServer }) => {
  //   if (isServer) {
  //     // Externalize sharp for server-side
  //     config.externals = config.externals || [];
  //     config.externals.push('sharp');
  //   }
  //   return config;
  // },

  // Headers for CORS
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET,POST,OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization, X-Tenant-Id' },
        ],
      },
    ];
  },
};

export default nextConfig;
