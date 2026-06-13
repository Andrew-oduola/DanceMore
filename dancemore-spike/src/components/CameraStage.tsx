"use client";

import type { RefObject, ReactNode } from "react";
import type { CameraErrorKind } from "@/hooks/usePoseDetection";

// The mirrored camera box with the skeleton overlay canvas on top, plus a
// loading veil and a camera-error recovery overlay (friendly message, retry,
// and unblock instructions when permission was denied). Shared by the trainer
// and the author tool so both wire up the same usePoseDetection refs.
export function CameraStage({
  videoRef,
  canvasRef,
  ready,
  error,
  errorKind,
  onRetry,
  containerStyle,
  children,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  ready: boolean;
  error: string | null;
  errorKind?: CameraErrorKind | null;
  onRetry?: () => void;
  // Sizing override (default: full-width 4:3). Synced split-screen passes a
  // height-constrained box so it scales down to share the viewport.
  containerStyle?: React.CSSProperties;
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
        ...containerStyle,
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
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            color: "#fff",
            background: "rgba(0,0,0,0.6)",
            textAlign: "center",
            padding: 24,
          }}
        >
          {!error ? (
            "Loading model…"
          ) : (
            <>
              <div style={{ fontWeight: 700 }}>
                {errorKind === "denied"
                  ? "Your browser is blocking the camera."
                  : errorKind === "notfound"
                    ? "No camera was found."
                    : `Camera error: ${error}`}
              </div>

              {errorKind === "denied" && (
                <div style={{ color: "#bbb", fontSize: "0.85rem", maxWidth: 420 }}>
                  Click the camera icon in your browser’s address bar, choose{" "}
                  <strong>Allow</strong>, then press <strong>Try again</strong>{" "}
                  (or reload the page).
                </div>
              )}
              {errorKind === "notfound" && (
                <div style={{ color: "#bbb", fontSize: "0.85rem", maxWidth: 420 }}>
                  Connect a camera, then press <strong>Try again</strong>.
                </div>
              )}

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
                {onRetry && (
                  <button onClick={onRetry} style={btn}>
                    Try again
                  </button>
                )}
                {errorKind === "denied" && (
                  <button
                    onClick={() => window.location.reload()}
                    style={{ ...btn, background: "#111" }}
                  >
                    Reload page
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Same button treatment used across the app (page.tsx et al).
const btn: React.CSSProperties = {
  padding: "10px 16px",
  fontSize: "0.95rem",
  fontWeight: 600,
  borderRadius: 6,
  border: "1px solid #444",
  background: "#1a1a1a",
  color: "#fff",
  cursor: "pointer",
};
