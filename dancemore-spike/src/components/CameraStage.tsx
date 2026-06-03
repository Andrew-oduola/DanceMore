"use client";

import type { RefObject, ReactNode } from "react";

// The mirrored camera box with the skeleton overlay canvas on top, plus a
// loading/error veil. Shared by the trainer and the author tool so both wire up
// the same usePoseDetection refs identically.
export function CameraStage({
  videoRef,
  canvasRef,
  ready,
  error,
  children,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  ready: boolean;
  error: string | null;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: "4 / 3",
        background: "#000",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: "scaleX(-1)",
        }}
      />
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          transform: "scaleX(-1)",
          pointerEvents: "none",
        }}
      />
      {children}
      {(!ready || error) && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            background: "rgba(0,0,0,0.4)",
            textAlign: "center",
            padding: 16,
          }}
        >
          {error ? `Error: ${error}` : "Loading model…"}
        </div>
      )}
    </div>
  );
}
