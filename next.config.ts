import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "192.168.1.68",
    "10.30.211.34",
  ], //TODO: change to localhost only as there will be reverse proxy in production
};

export default nextConfig;
