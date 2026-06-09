import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@xenova/transformers", "fluent-ffmpeg"],
};

export default nextConfig;
