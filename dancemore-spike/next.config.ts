import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      // pose-detection's barrel statically imports `Pose` from "@mediapipe/pose"
      // for its MediaPipe runtime, which we don't use. The real package has no
      // ESM exports, so alias it to a stub to keep the build happy.
      "@mediapipe/pose": "./src/lib/mediapipe-pose-stub.js",
    },
  },
};

export default nextConfig;
