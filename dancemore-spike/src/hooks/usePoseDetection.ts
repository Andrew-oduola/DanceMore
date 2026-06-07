"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as poseDetection from "@tensorflow-models/pose-detection";
import { createMoveNetDetector } from "@/lib/detector";
import { angleVector, type KP } from "@/lib/pose";

const MIN_CONF = 0.3;
// Fallback ghost sizing when the user isn't detected: a standing person's
// torso (shoulder-center → hip-center) is roughly this fraction of the frame.
const GHOST_FALLBACK_TORSO = 0.18;

// Called once per frame with the latest keypoints and their angle-vector.
export type OnFrame = (keypoints: KP[], angles: Record<number, number>) => void;

// Why the camera failed — drives the recovery UI in CameraStage.
export type CameraErrorKind = "denied" | "notfound" | "generic";

// Hip-center + torso length — the anchor used to place and scale the ghost.
function anchorOf(
  keypoints: KP[]
): { hip: { x: number; y: number }; torso: number } | null {
  const by: Record<string, KP> = {};
  for (const k of keypoints) by[k.name] = k;
  const parts = [
    by["left_hip"],
    by["right_hip"],
    by["left_shoulder"],
    by["right_shoulder"],
  ];
  if (parts.some((p) => !p || p.score < MIN_CONF)) return null;
  const [lh, rh, ls, rs] = parts as KP[];
  const hip = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  const shoulder = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const torso = Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y);
  return torso > 1 ? { hip, torso } : null;
}

// Sets up getUserMedia + MoveNet SINGLEPOSE_LIGHTNING (webgl, tfjs runtime),
// runs ONE requestAnimationFrame loop, draws the cyan/white skeleton overlay,
// and invokes onFrame(keypoints, angles) each frame. Tears everything down on
// unmount. Returns refs to wire up the <video>/<canvas> plus ready/error state.
export function usePoseDetection(onFrame?: OnFrame) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Store onFrame in a ref so consumers can pass a fresh inline closure every
  // render without re-subscribing or restarting the rAF loop. Synced in an
  // effect (not during render) so the loop always sees the latest closure.
  const onFrameRef = useRef<OnFrame | undefined>(onFrame);
  useEffect(() => {
    onFrameRef.current = onFrame;
  });

  // The target pose to draw as a ghost under the live skeleton. Consumers set
  // ghostRef.current to the current checkpoint's stored keypoints (or null) —
  // a ref, so swapping targets never restarts the loop.
  const ghostRef = useRef<KP[] | null>(null);

  const detectorRef = useRef<poseDetection.PoseDetector | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<CameraErrorKind | null>(null);

  // Re-callable camera start, wired up inside the effect. Exposed as a stable
  // `retry` so the error overlay's "Try again" can re-prompt for the camera.
  const startCameraRef = useRef<(() => void) | null>(null);
  const retry = useCallback(() => startCameraRef.current?.(), []);

  useEffect(() => {
    let cancelled = false;
    const adjacentPairs = poseDetection.util.getAdjacentPairs(
      poseDetection.SupportedModels.MoveNet
    );

    // Draw the target checkpoint's pose as a translucent magenta ghost,
    // translated + uniformly scaled so its hip-center and torso length match
    // the user's — "bend until you cover the glow". Falls back to a centered,
    // sensibly-sized ghost when either side lacks confident hips/shoulders.
    function drawGhost(
      ctx: CanvasRenderingContext2D,
      canvas: HTMLCanvasElement,
      ghost: KP[],
      live: KP[]
    ) {
      const g = anchorOf(ghost);
      if (!g) return; // reference itself lacks anchors — nothing sane to draw
      const u = anchorOf(live);
      const scale = u
        ? u.torso / g.torso
        : (canvas.height * GHOST_FALLBACK_TORSO) / g.torso;
      const at = u
        ? u.hip
        : { x: canvas.width / 2, y: canvas.height * 0.55 };
      const map = (k: KP) => ({
        x: at.x + (k.x - g.hip.x) * scale,
        y: at.y + (k.y - g.hip.y) * scale,
      });

      ctx.save();
      ctx.strokeStyle = "rgba(255, 64, 255, 0.55)";
      ctx.fillStyle = "rgba(255, 64, 255, 0.55)";
      ctx.lineWidth = 6;
      ctx.lineCap = "round";
      ctx.shadowColor = "rgba(255, 64, 255, 0.8)";
      ctx.shadowBlur = 10;
      for (const [i, j] of adjacentPairs) {
        const a = ghost[i];
        const b = ghost[j];
        if (a && b && a.score >= MIN_CONF && b.score >= MIN_CONF) {
          const pa = map(a);
          const pb = map(b);
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
        }
      }
      for (const kp of ghost) {
        if (kp.score >= MIN_CONF) {
          const p = map(kp);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5, 0, 2 * Math.PI);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    function drawSkeleton(keypoints: KP[]) {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) return;
      if (
        canvas.width !== video.videoWidth ||
        canvas.height !== video.videoHeight
      ) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // target pose first, so the user's skeleton draws on top of it
      if (ghostRef.current) drawGhost(ctx, canvas, ghostRef.current, keypoints);

      // edges
      ctx.strokeStyle = "cyan";
      ctx.lineWidth = 3;
      for (const [i, j] of adjacentPairs) {
        const a = keypoints[i];
        const b = keypoints[j];
        if (a && b && a.score >= MIN_CONF && b.score >= MIN_CONF) {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      // joints
      ctx.fillStyle = "white";
      for (const kp of keypoints) {
        if (kp.score >= MIN_CONF) {
          ctx.beginPath();
          ctx.arc(kp.x, kp.y, 4, 0, 2 * Math.PI);
          ctx.fill();
        }
      }
    }

    async function loop() {
      const detector = detectorRef.current;
      const video = videoRef.current;
      if (detector && video && video.readyState >= 2) {
        try {
          const poses = await detector.estimatePoses(video, {
            flipHorizontal: false,
          });
          if (poses[0]) {
            const keypoints: KP[] = poses[0].keypoints.map((k) => ({
              x: k.x,
              y: k.y,
              score: k.score ?? 0,
              name: k.name ?? "",
            }));
            drawSkeleton(keypoints);
            onFrameRef.current?.(keypoints, angleVector(keypoints));
          }
        } catch {
          // estimatePoses can throw transiently while the video resizes; ignore
        }
      }
      if (!cancelled) rafRef.current = requestAnimationFrame(loop);
    }

    // Re-callable camera + detector start. On success it resumes the normal
    // flow (live feed + detection loop) exactly as a first-try grant would.
    let starting = false;
    async function startCamera() {
      if (cancelled || starting) return;
      // Already running? (e.g. a spurious permission-change event) — no-op.
      if (
        streamRef.current?.getTracks().some((t) => t.readyState === "live")
      )
        return;
      starting = true;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
        }

        if (!detectorRef.current) {
          const detector = await createMoveNetDetector();
          if (cancelled) {
            detector.dispose();
            return;
          }
          detectorRef.current = detector;
        }
        setError(null);
        setErrorKind(null);
        setReady(true);
        if (rafRef.current === null)
          rafRef.current = requestAnimationFrame(loop);
      } catch (err) {
        if (cancelled) return;
        const name = err instanceof Error ? err.name : "";
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setErrorKind("denied");
          setError("Camera access was denied.");
        } else if (
          name === "NotFoundError" ||
          name === "DevicesNotFoundError"
        ) {
          setErrorKind("notfound");
          setError("No camera was found.");
        } else {
          setErrorKind("generic");
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        starting = false;
      }
    }
    startCameraRef.current = startCamera;

    startCamera();

    // Permissions API (when available): if the camera is hard-blocked, surface
    // the recovery instructions proactively, and auto-restart the feed the
    // moment the user flips the site setting to Allow. Browsers without the
    // API (or without 'camera' support) fall back to Try-again + instructions.
    let permStatus: PermissionStatus | null = null;
    (async () => {
      try {
        if (!navigator.permissions?.query) return;
        permStatus = await navigator.permissions.query({
          name: "camera" as PermissionName,
        });
        if (cancelled) return;
        if (permStatus.state === "denied") {
          setErrorKind("denied");
          setError("Camera access is blocked.");
        }
        permStatus.onchange = () => {
          // startCamera() no-ops unless we're actually down (guards above).
          if (!cancelled && permStatus?.state === "granted") startCamera();
        };
      } catch {
        // Permissions API unsupported here — the manual retry path covers it.
      }
    })();

    return () => {
      cancelled = true;
      if (permStatus) permStatus.onchange = null;
      startCameraRef.current = null;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      detectorRef.current?.dispose();
      detectorRef.current = null;
    };
  }, []);

  return { videoRef, canvasRef, ready, error, errorKind, retry, ghostRef };
}
