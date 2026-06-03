"use client";

import { useEffect, useRef, useState } from "react";
import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-converter";
import "@tensorflow/tfjs-backend-webgl";
import * as poseDetection from "@tensorflow-models/pose-detection";
import { angleVector, type KP } from "@/lib/pose";

const MIN_CONF = 0.3;

// Called once per frame with the latest keypoints and their angle-vector.
export type OnFrame = (keypoints: KP[], angles: Record<number, number>) => void;

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

  const detectorRef = useRef<poseDetection.PoseDetector | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const adjacentPairs = poseDetection.util.getAdjacentPairs(
      poseDetection.SupportedModels.MoveNet
    );

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

    async function init() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
        }

        await tf.setBackend("webgl");
        await tf.ready();
        const detector = await poseDetection.createDetector(
          poseDetection.SupportedModels.MoveNet,
          { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING }
        );
        if (cancelled) {
          detector.dispose();
          return;
        }
        detectorRef.current = detector;
        setReady(true);
        rafRef.current = requestAnimationFrame(loop);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    init();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      detectorRef.current?.dispose();
      detectorRef.current = null;
    };
  }, []);

  return { videoRef, canvasRef, ready, error };
}
