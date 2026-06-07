"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { usePoseDetection } from "@/hooks/usePoseDetection";
import { CameraStage } from "@/components/CameraStage";
import type { Checkpoint, Move } from "@/lib/moves";
import type { KP } from "@/lib/pose";

// Developer plumbing — not part of the client-facing UX. Capture the live pose
// as checkpoints, then export a complete Move as JSON to paste into moves.json.
export default function AuthorPage() {
  const [moveName, setMoveName] = useState("");
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [note, setNote] = useState("");

  // Latest angle-vector + raw keypoints, updated every frame but kept out of
  // React state. Keypoints ride along on the checkpoint for the ghost overlay.
  const anglesRef = useRef<Record<number, number>>({});
  const keypointsRef = useRef<KP[]>([]);
  const { videoRef, canvasRef, ready, error, errorKind, retry } =
    usePoseDetection((kp, angles) => {
      anglesRef.current = angles;
      keypointsRef.current = kp;
    });

  function addCheckpoint() {
    const angles = anglesRef.current;
    if (Object.keys(angles).length < 4) {
      setNote("Not enough joints visible — stand back and try again.");
      return;
    }
    setCheckpoints((prev) => [
      ...prev,
      {
        name: `Pose ${prev.length + 1}`,
        angles: { ...angles },
        keypoints: keypointsRef.current.map((k) => ({ ...k })),
      },
    ]);
    setNote(`Captured (${Object.keys(angles).length} joints).`);
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
    const move: Move = {
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      name,
      checkpoints,
    };
    const blob = new Blob([JSON.stringify(move, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${move.id || "move"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

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
      />

      <input
        type="text"
        value={moveName}
        onChange={(e) => setMoveName(e.target.value)}
        placeholder="Move name (e.g. Side Step Reach)"
        style={{
          width: "100%",
          padding: "10px 12px",
          fontSize: "1rem",
          borderRadius: 6,
          border: "1px solid #444",
          background: "#111",
          color: "#fff",
        }}
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

      {note && <div style={{ color: "#22c55e", fontSize: "0.9rem" }}>{note}</div>}

      <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
        {checkpoints.length === 0 && (
          <p style={{ color: "#888", textAlign: "center" }}>
            No checkpoints yet. Strike a pose and hit “Add Checkpoint”.
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
              border: "1px solid #333",
              background: "#1a1a1a",
            }}
          >
            <span style={{ color: "#888", width: 24 }}>{i + 1}.</span>
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
            <span style={{ color: "#666", fontSize: "0.8rem" }}>
              {Object.keys(cp.angles).length} joints
            </span>
          </div>
        ))}
      </div>
    </main>
  );
}

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
