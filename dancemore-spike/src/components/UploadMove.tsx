"use client";

import { useEffect, useRef, useState } from "react";
import type { PoseDetector } from "@tensorflow-models/pose-detection";
import { createMoveNetDetector } from "@/lib/detector";
import {
  captureFrame,
  extractCandidates,
  mirrorAngles,
  mirrorKeypoints,
  type Candidate,
} from "@/lib/extract";
import type { Move } from "@/lib/moves";

const SAMPLE_COUNT = 10;
const MIN_KEEP = 2;
const MAX_KEEP = 12;

type Curated = Candidate & { name: string; keep: boolean };

type Stage =
  | { kind: "pick" }
  | { kind: "extracting"; pct: number }
  | { kind: "review" };

// Upload a dance clip → sample frames through MoveNet → curate the detected
// poses into checkpoints → save as a session-local Move. The clip itself
// becomes the move's WATCH demo (object URL, alive while the move exists).
export function UploadMove({
  onSave,
  onCancel,
}: {
  onSave: (move: Move) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const detectorRef = useRef<PoseDetector | null>(null);
  const savedRef = useRef(false);
  const urlRef = useRef<string | null>(null);

  const [stage, setStage] = useState<Stage>({ kind: "pick" });
  const [url, setUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [candidates, setCandidates] = useState<Curated[]>([]);
  const [moveName, setMoveName] = useState("");
  const [description, setDescription] = useState("");
  const [mirror, setMirror] = useState(false);
  const [note, setNote] = useState("");
  const [lowConfHint, setLowConfHint] = useState(false);

  // Tear down the detector; revoke the clip URL only if it wasn't saved into
  // a move (WATCH replays it after save).
  useEffect(() => {
    return () => {
      detectorRef.current?.dispose();
      detectorRef.current = null;
      if (!savedRef.current && urlRef.current)
        URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    const objectUrl = URL.createObjectURL(file);
    urlRef.current = objectUrl;
    setUrl(objectUrl);
    const base = file.name.replace(/\.[^.]+$/, "");
    setFileName(base);
    setMoveName(base);
    setStage({ kind: "extracting", pct: 0 });
    setNote("");

    try {
      const video = videoRef.current;
      if (!video) throw new Error("player not ready");
      video.src = objectUrl;
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("Could not read that video"));
      });

      if (!detectorRef.current)
        detectorRef.current = await createMoveNetDetector();

      const found = await extractCandidates(
        video,
        detectorRef.current,
        SAMPLE_COUNT,
        (pct) => setStage({ kind: "extracting", pct })
      );
      setCandidates(
        found.map((c, i) => ({ ...c, name: `Pose ${i + 1}`, keep: true }))
      );
      if (found.length === 0)
        setNote(
          "No clear poses found automatically — scrub the video below and capture frames by hand."
        );
      setStage({ kind: "review" });
    } catch (err) {
      URL.revokeObjectURL(objectUrl);
      urlRef.current = null;
      setUrl(null);
      setNote(err instanceof Error ? err.message : String(err));
      setStage({ kind: "pick" });
    }
  }

  async function captureCurrent() {
    const video = videoRef.current;
    const detector = detectorRef.current;
    if (!video || !detector) return;
    video.pause();
    const c = await captureFrame(video, detector);
    // Never block: only a genuine detector failure (no pose object) stops us.
    if (!c) {
      setNote("");
      setLowConfHint(false);
      return;
    }
    setNote("");
    // Soft, non-blocking hint — the frame is captured either way.
    setLowConfHint(c.lowConfidence);
    setCandidates((prev) => [
      ...prev,
      { ...c, name: `Pose ${prev.length + 1}`, keep: true },
    ]);
  }

  const kept = candidates.filter((c) => c.keep);
  const canSave =
    kept.length >= MIN_KEEP && kept.length <= MAX_KEEP && moveName.trim();

  function save() {
    if (!canSave || !url) return;
    savedRef.current = true;
    onSave({
      id: `upload-${Date.now().toString(36)}`,
      name: moveName.trim(),
      description: description.trim() || undefined,
      demoVideo: url,
      checkpoints: kept.map((c) => ({
        name: c.name.trim() || "Pose",
        // Mirror is applied to BOTH representations at save time so the ghost
        // overlay and angle scoring always agree.
        angles: mirror ? mirrorAngles(c.angles) : c.angles,
        keypoints: mirror ? mirrorKeypoints(c.keypoints) : c.keypoints,
      })),
    });
  }

  return (
    <div
      style={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 16,
        alignItems: "center",
      }}
    >
      <div style={{ width: "100%", textAlign: "center" }}>
        <div style={{ fontSize: "1.35rem", fontWeight: 700 }}>
          Upload a dance
        </div>
        <div style={{ color: "#888", marginTop: 2 }}>
          We’ll pull the key poses out of the clip — you pick the ones to
          practice.
        </div>
      </div>

      {stage.kind === "pick" && (
        <>
          <label
            style={{
              padding: "40px 32px",
              border: "2px dashed #333",
              borderRadius: 12,
              color: "#888",
              cursor: "pointer",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: "2rem", marginBottom: 8 }}>⬆</div>
            Choose a video file
            <input
              type="file"
              accept="video/*"
              onChange={onFile}
              style={{ display: "none" }}
            />
          </label>
          {note && <div style={{ color: "#ef4444" }}>{note}</div>}
        </>
      )}

      {/* The clip player: hidden until there's a file; during extraction it's
          the (seeking) source under a progress veil, in review it's the
          scrubber. */}
      <div
        style={{
          position: "relative",
          width: "100%",
          display: stage.kind === "pick" ? "none" : "block",
        }}
      >
        <video
          ref={videoRef}
          muted
          playsInline
          controls={stage.kind === "review"}
          style={{
            width: "100%",
            maxHeight: 360,
            background: "#000",
            borderRadius: 8,
          }}
        />
        {stage.kind === "extracting" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              background: "rgba(0,0,0,0.6)",
              borderRadius: 8,
            }}
          >
            <div style={{ fontWeight: 700 }}>
              Analyzing the dance… {stage.pct}%
            </div>
            <div
              style={{
                width: "60%",
                height: 8,
                background: "#1a1a1a",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${stage.pct}%`,
                  height: "100%",
                  background: "#22d3ee",
                  transition: "width 120ms linear",
                }}
              />
            </div>
          </div>
        )}
      </div>

      {stage.kind === "review" && (
        <>
          <button onClick={captureCurrent} style={btn}>
            📸 Capture this frame as a checkpoint
          </button>
          {note && <div style={{ color: "#f59e0b" }}>{note}</div>}
          {lowConfHint && (
            <div
              style={{
                color: "#b08534",
                fontSize: "0.8rem",
                maxWidth: 420,
                textAlign: "center",
              }}
            >
              Pose looks partly unclear on this frame — you can still use it,
              but scoring may be less precise.
            </div>
          )}

          {candidates.length > 0 && (
            <div
              style={{
                width: "100%",
                display: "flex",
                gap: 10,
                overflowX: "auto",
                padding: "4px 2px",
              }}
            >
              {candidates.map((c, i) => (
                <div
                  key={c.id}
                  style={{
                    flex: "0 0 150px",
                    border: `1px solid ${c.keep ? "#164e63" : "#2a2a2a"}`,
                    borderRadius: 8,
                    overflow: "hidden",
                    background: "#111",
                    opacity: c.keep ? 1 : 0.45,
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={c.thumb}
                    alt={c.name}
                    style={{ width: "100%", display: "block" }}
                  />
                  <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                    <input
                      type="text"
                      aria-label="Checkpoint name"
                      value={c.name}
                      onChange={(e) =>
                        setCandidates((prev) =>
                          prev.map((p, j) =>
                            j === i ? { ...p, name: e.target.value } : p
                          )
                        )
                      }
                      style={{
                        width: "100%",
                        padding: "4px 6px",
                        fontSize: "0.8rem",
                        borderRadius: 4,
                        border: "1px solid #333",
                        background: "#0a0a0a",
                        color: "#fff",
                      }}
                    />
                    {c.lowConfidence && (
                      <span style={{ color: "#b08534", fontSize: "0.7rem" }}>
                        ⚠ low confidence
                      </span>
                    )}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ color: "#666", fontSize: "0.7rem" }}>
                        @{c.time.toFixed(1)}s
                      </span>
                      <button
                        onClick={() =>
                          setCandidates((prev) =>
                            prev.map((p, j) =>
                              j === i ? { ...p, keep: !p.keep } : p
                            )
                          )
                        }
                        style={{
                          background: "none",
                          border: "none",
                          color: c.keep ? "#ef4444" : "#22c55e",
                          cursor: "pointer",
                          fontSize: "0.75rem",
                          padding: 0,
                        }}
                      >
                        {c.keep ? "✕ Remove" : "↩ Keep"}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div
            style={{
              width: "100%",
              maxWidth: 440,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <input
              type="text"
              value={moveName}
              onChange={(e) => setMoveName(e.target.value)}
              placeholder={`Move name (default: ${fileName})`}
              style={input}
            />
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (optional)"
              style={input}
            />
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: "#bbb",
                fontSize: "0.9rem",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={mirror}
                onChange={(e) => setMirror(e.target.checked)}
                style={{ accentColor: "#22d3ee" }}
              />
              Dancer faces me (mirror) — flip left/right when scoring
            </label>

            <button
              onClick={save}
              disabled={!canSave}
              style={{
                padding: "12px 16px",
                fontSize: "1rem",
                fontWeight: 700,
                borderRadius: 8,
                border: "1px solid #14532d",
                background: canSave ? "#16a34a" : "#1a1a1a",
                color: canSave ? "#04130a" : "#666",
                cursor: canSave ? "pointer" : "not-allowed",
              }}
            >
              {canSave
                ? `Save move (${kept.length} checkpoints)`
                : `Keep ${MIN_KEEP}–${MAX_KEEP} checkpoints to save (${kept.length} kept)`}
            </button>
          </div>
        </>
      )}

      <button
        onClick={onCancel}
        style={{
          background: "none",
          border: "none",
          color: "#666",
          cursor: "pointer",
          fontSize: "0.85rem",
        }}
      >
        Cancel
      </button>
    </div>
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

const input: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: "1rem",
  borderRadius: 6,
  border: "1px solid #444",
  background: "#111",
  color: "#fff",
};
