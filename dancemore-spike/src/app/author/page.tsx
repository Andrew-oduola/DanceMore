"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import * as poseDetection from "@tensorflow-models/pose-detection";
import { usePoseDetection } from "@/hooks/usePoseDetection";
import { CameraStage } from "@/components/CameraStage";
import type { Checkpoint, Move } from "@/lib/moves";
import { MIN_CONF, scorePose, type KP } from "@/lib/pose";
import { hasFullBody, passHasLegs } from "@/lib/bodyGate";

// Two consecutive checkpoints scoring at/above this are "too similar" — a move
// made of near-identical poses can be gamed by barely moving.
const SIMILAR_THRESHOLD = 88;
const THUMB_W = 200;

// UI-only augmentation: a thumbnail + quality flags that aren't exported.
type Authored = Checkpoint & { thumb: string; legDriven: boolean };

// Developer plumbing — capture the live pose as checkpoints, then export a
// complete Move as JSON to paste into moves.json. The tool now enforces the
// capture checklist: full body required, legs must be captured, poses distinct.
export default function AuthorPage() {
  const [moveName, setMoveName] = useState("");
  const [youtubeId, setYoutubeId] = useState("");
  const [checkpoints, setCheckpoints] = useState<Authored[]>([]);
  const [note, setNote] = useState("");
  const [noteKind, setNoteKind] = useState<"ok" | "warn" | "err">("ok");

  // Latest angle-vector + raw keypoints, updated every frame but kept out of
  // React state. Keypoints ride along on the checkpoint for the ghost overlay.
  const anglesRef = useRef<Record<number, number>>({});
  const keypointsRef = useRef<KP[]>([]);
  const fullBodyRef = useRef(false);
  const promptRef = useRef<HTMLDivElement>(null);

  const { videoRef, canvasRef, ready, error, errorKind, retry } =
    usePoseDetection((kp, angles) => {
      anglesRef.current = angles;
      keypointsRef.current = kp;
      const full = hasFullBody(kp);
      fullBodyRef.current = full;
      const p = promptRef.current;
      if (p) p.style.opacity = full ? "0" : "1";
    });

  function addCheckpoint() {
    const angles = anglesRef.current;
    const kp = keypointsRef.current;
    const video = videoRef.current;

    // Full-body gate: a checkpoint that doesn't capture the legs can never be
    // passed in practice (≥2 lower-body joints required), so refuse it here.
    if (!fullBodyRef.current) {
      setNoteKind("err");
      setNote(
        "Legs aren’t fully in frame — step back so hips, knees and ankles are visible, then capture."
      );
      return;
    }
    if (Object.keys(angles).length < 4) {
      setNoteKind("err");
      setNote("Not enough joints visible — stand back and try again.");
      return;
    }

    const legDriven = passHasLegs(angles, angles); // ≥2 lower-body joints present
    const thumb = video ? drawThumb(video, kp) : "";

    // Distinctness check vs the previous checkpoint.
    const prev = checkpoints[checkpoints.length - 1];
    const sim = prev ? scorePose(prev.angles, angles) : null;
    const tooSimilar = sim !== null && sim >= SIMILAR_THRESHOLD;

    setCheckpoints((prev) => [
      ...prev,
      {
        name: `Pose ${prev.length + 1}`,
        angles: { ...angles },
        keypoints: kp.map((k) => ({ ...k })),
        thumb,
        legDriven,
      },
    ]);

    if (tooSimilar) {
      setNoteKind("warn");
      setNote(
        `Captured — but very similar to the previous pose (${sim}). Make this one clearly different or it can be gamed by barely moving.`
      );
    } else if (!legDriven) {
      setNoteKind("warn");
      setNote(
        "Captured — but the legs aren’t doing much. Bend a knee / step wide so the pose is leg-driven."
      );
    } else {
      setNoteKind("ok");
      setNote(
        `Captured a full-body, leg-driven pose (${Object.keys(angles).length} joints).`
      );
    }
  }

  function removeLast() {
    setCheckpoints((prev) => prev.slice(0, -1));
    setNote("");
  }

  function renameCheckpoint(i: number, name: string) {
    setCheckpoints((prev) =>
      prev.map((cp, j) => (j === i ? { ...cp, name } : cp))
    );
  }

  function exportMove() {
    const name = moveName.trim() || "Untitled Move";
    const id = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    // Strip the UI-only fields; export the exact Move/Checkpoint shape.
    const move: Move = {
      id,
      name,
      ...(youtubeId.trim() ? { youtubeId: youtubeId.trim() } : {}),
      checkpoints: checkpoints.map((cp) => ({
        name: cp.name,
        angles: cp.angles,
        keypoints: cp.keypoints,
      })),
    };
    const blob = new Blob([JSON.stringify(move, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${id || "move"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const legDrivenCount = checkpoints.filter((c) => c.legDriven).length;

  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 16,
        alignItems: "center",
      }}
    >
      <div
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <h1 style={{ fontSize: "1.4rem", margin: 0 }}>
          <span className="wordmark">DanceMore</span>{" "}
          <span style={{ color: "#888", fontWeight: 600 }}>· Move Author</span>
        </h1>
        <Link href="/" style={{ color: "#666", fontSize: "0.85rem" }}>
          ← Trainer
        </Link>
      </div>

      <CameraStage
        videoRef={videoRef}
        canvasRef={canvasRef}
        ready={ready}
        error={error}
        errorKind={errorKind}
        onRetry={retry}
      >
        {/* Live full-body prompt — fades in whenever the legs leave frame. */}
        <div
          ref={promptRef}
          data-testid="fullbody-prompt"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 14,
            margin: "0 auto",
            width: "fit-content",
            maxWidth: "90%",
            padding: "8px 14px",
            borderRadius: 10,
            background: "rgba(0,0,0,0.6)",
            color: "#fbbf24",
            fontSize: "0.9rem",
            fontWeight: 600,
            textAlign: "center",
            opacity: 0,
            transition: "opacity 0.15s ease",
            pointerEvents: "none",
          }}
        >
          Step back so we can see your whole body — legs included.
        </div>
      </CameraStage>

      <input
        type="text"
        value={moveName}
        onChange={(e) => setMoveName(e.target.value)}
        placeholder="Move name (e.g. Side Step & Cross)"
        style={field}
      />
      <input
        type="text"
        value={youtubeId}
        onChange={(e) => setYoutubeId(e.target.value)}
        placeholder="YouTube demo ID or URL (optional) — the same dance"
        style={field}
      />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
        <button onClick={addCheckpoint} style={btn}>
          Add Checkpoint
        </button>
        <button
          onClick={removeLast}
          disabled={checkpoints.length === 0}
          style={{ ...btn, opacity: checkpoints.length === 0 ? 0.5 : 1 }}
        >
          Remove last checkpoint
        </button>
        <button
          onClick={exportMove}
          disabled={checkpoints.length === 0}
          style={{ ...btn, opacity: checkpoints.length === 0 ? 0.5 : 1 }}
        >
          Export Move (JSON)
        </button>
      </div>

      {note && (
        <div
          style={{
            color:
              noteKind === "ok"
                ? "#22c55e"
                : noteKind === "warn"
                  ? "#fbbf24"
                  : "#ef4444",
            fontSize: "0.9rem",
            textAlign: "center",
            maxWidth: 460,
          }}
        >
          {note}
        </div>
      )}

      {checkpoints.length > 0 && (
        <div style={{ color: "#888", fontSize: "0.85rem" }}>
          {checkpoints.length} checkpoints · {legDrivenCount} leg-driven
          {checkpoints.length < 5 && " · aim for 5–8"}
        </div>
      )}

      <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
        {checkpoints.length === 0 && (
          <p style={{ color: "#888", textAlign: "center" }}>
            No checkpoints yet. Get your whole body in frame, strike a clear
            leg-driven pose, and hit “Add Checkpoint”.
          </p>
        )}
        {checkpoints.map((cp, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              padding: "10px 14px",
              borderRadius: 8,
              border: `1px solid ${cp.legDriven ? "#333" : "#78350f"}`,
              background: "#1a1a1a",
            }}
          >
            <span style={{ color: "#888", width: 20 }}>{i + 1}.</span>
            {cp.thumb && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={cp.thumb}
                alt={cp.name}
                style={{ width: 72, borderRadius: 4, display: "block" }}
              />
            )}
            <input
              type="text"
              value={cp.name}
              onChange={(e) => renameCheckpoint(i, e.target.value)}
              style={{
                flex: 1,
                padding: "6px 8px",
                fontSize: "0.95rem",
                borderRadius: 4,
                border: "1px solid #444",
                background: "#111",
                color: "#fff",
              }}
            />
            <span
              style={{
                fontSize: "0.72rem",
                fontWeight: 600,
                color: cp.legDriven ? "#4ade80" : "#fbbf24",
                whiteSpace: "nowrap",
              }}
            >
              {cp.legDriven
                ? "✓ leg-driven"
                : "⚠ legs not captured"}
            </span>
          </div>
        ))}
      </div>
    </main>
  );
}

// Draw a mirrored thumbnail (matching the on-screen mirror) of the current
// webcam frame with the captured skeleton on top.
const adjacentPairs = poseDetection.util.getAdjacentPairs(
  poseDetection.SupportedModels.MoveNet
);
function drawThumb(video: HTMLVideoElement, keypoints: KP[]): string {
  if (!video.videoWidth) return "";
  const scale = THUMB_W / video.videoWidth;
  const w = THUMB_W;
  const h = Math.round(video.videoHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.translate(w, 0);
  ctx.scale(-1, 1); // mirror to match the live view
  ctx.drawImage(video, 0, 0, w, h);
  ctx.strokeStyle = "cyan";
  ctx.lineWidth = 2;
  for (const [i, j] of adjacentPairs) {
    const a = keypoints[i];
    const b = keypoints[j];
    if (a && b && a.score >= MIN_CONF && b.score >= MIN_CONF) {
      ctx.beginPath();
      ctx.moveTo(a.x * scale, a.y * scale);
      ctx.lineTo(b.x * scale, b.y * scale);
      ctx.stroke();
    }
  }
  ctx.fillStyle = "white";
  for (const kp of keypoints) {
    if (kp.score >= MIN_CONF) {
      ctx.beginPath();
      ctx.arc(kp.x * scale, kp.y * scale, 2.5, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  return canvas.toDataURL("image/jpeg", 0.7);
}

const field: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  fontSize: "1rem",
  borderRadius: 6,
  border: "1px solid #444",
  background: "#111",
  color: "#fff",
};

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
