"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePoseDetection } from "@/hooks/usePoseDetection";
import { CameraStage } from "@/components/CameraStage";
import { hasFullBody } from "@/lib/bodyGate";
import { scoreColor } from "@/lib/scoreColor";
import { validYoutubeId, type Move } from "@/lib/moves";
import {
  scoreCheckpointFrame,
  activeCheckpoint,
  WINDOW_POST,
} from "@/lib/practiceScore";
import { loadYouTubeApi, type YTPlayer } from "@/lib/youtube";

type Phase = "loading" | "prestart" | "running" | "finished";

// Synced (dance-along) practice: the YouTube demo plays on top while the webcam
// scores below. The video's playback TIME (never its pixels) selects which
// checkpoint is active; scoring itself is the EXACT shared core
// (scoreCheckpointFrame) — same gate, leg requirement, pass-through, thresholds.
export function SyncedPractice({
  move,
  onFinish,
  onBack,
}: {
  move: Move;
  onFinish: (peaks: number[]) => void;
  onBack: () => void;
}) {
  const videoId = validYoutubeId(move)!;
  const offset = move.videoOffset ?? 0;

  // Timestamped checkpoints, ascending by t, keeping their original indices so
  // the result breakdown stays in move order.
  const timed = useMemo(
    () =>
      move.checkpoints
        .map((cp, i) => ({ cp, i }))
        .filter((x) => typeof x.cp.t === "number")
        .sort((a, b) => (a.cp.t as number) - (b.cp.t as number)),
    [move]
  );
  const sortedTs = useMemo(() => timed.map((x) => x.cp.t as number), [timed]);
  const lastWindowEnd = sortedTs[sortedTs.length - 1] + WINDOW_POST;

  // Live, per-frame state kept out of React.
  const scoreRef = useRef<HTMLDivElement>(null);
  const holdBarRef = useRef<HTMLDivElement>(null);
  const peaksRef = useRef<number[]>(move.checkpoints.map(() => 0));
  const scoreBufRef = useRef<number[]>([]);
  const passStartRef = useRef<number | null>(null);
  const activeSortedRef = useRef<number>(-1);
  const fullBodyRef = useRef(false);

  const playerRef = useRef<YTPlayer | null>(null);
  const playerHostRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef<Phase>("loading");
  const pausedRef = useRef(false);
  const finishedRef = useRef(false);

  const [phase, setPhase] = useState<Phase>("loading");
  const [readyToStart, setReadyToStart] = useState(false);
  // Active checkpoint (index into `timed`, or -1). Set from the sync loop only
  // when it changes; drives the ghost overlay (in an effect) and the label.
  const [activeSorted, setActiveSorted] = useState(-1);
  const activeLabel = activeSorted >= 0 ? timed[activeSorted].cp.name : "";
  const setPhaseBoth = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  function writeChip(text: string, color: string, size: string) {
    const el = scoreRef.current;
    if (!el) return;
    el.textContent = text;
    el.style.color = color;
    el.style.fontSize = size;
  }

  function finish() {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setPhaseBoth("finished");
    try {
      playerRef.current?.pauseVideo();
    } catch {
      /* player may be gone */
    }
    onFinish([...peaksRef.current]);
  }

  const { videoRef, canvasRef, ready, error, errorKind, retry, ghostRef } =
    usePoseDetection((kp, angles) => {
      const full = hasFullBody(kp);

      // Pre-start: gate the Start button on the full body being in frame.
      if (phaseRef.current === "prestart") {
        if (full !== fullBodyRef.current) {
          fullBodyRef.current = full;
          setReadyToStart(full);
        }
        if (full) writeChip("Ready — press Start", "#4ade80", "1.1rem");
        else
          writeChip(
            "Step back so we can see your whole body — legs included.",
            "#fbbf24",
            "0.95rem"
          );
        return;
      }

      if (phaseRef.current !== "running") return;

      if (pausedRef.current) {
        writeChip("Paused", "#aaa", "1.1rem");
        passStartRef.current = null;
        if (holdBarRef.current) holdBarRef.current.style.width = "0%";
        return;
      }

      const player = playerRef.current;
      if (!player) return;
      const vt = player.getCurrentTime() + offset;

      // End once we're past the final checkpoint's window (don't wait out a
      // long video tail); ENDED also finishes via onStateChange.
      if (vt >= lastWindowEnd) {
        finish();
        return;
      }

      const p = activeCheckpoint(sortedTs, vt);
      if (p === -1) {
        // Between windows — get ready for the next pose; not scoring.
        writeChip("Get ready…", "#888", "1.1rem");
        passStartRef.current = null;
        if (holdBarRef.current) holdBarRef.current.style.width = "0%";
        return;
      }

      if (p !== activeSortedRef.current) {
        activeSortedRef.current = p;
        scoreBufRef.current = [];
        passStartRef.current = null;
        setActiveSorted(p); // ghost is set from this in an effect
      }

      const r = scoreCheckpointFrame(
        kp,
        angles,
        timed[p].cp.angles,
        scoreBufRef.current,
        passStartRef.current,
        performance.now()
      );
      passStartRef.current = r.passStart;

      if (r.state === "no-body") {
        writeChip(
          "Step back so we can see your whole body — legs included.",
          "#fbbf24",
          "0.95rem"
        );
        if (holdBarRef.current) holdBarRef.current.style.width = "0%";
        return;
      }
      if (r.state === "get-into-frame") {
        writeChip("Get into frame", "#aaa", "1.1rem");
        if (holdBarRef.current) holdBarRef.current.style.width = "0%";
        return;
      }

      const smoothed = r.smoothed as number;
      writeChip(String(smoothed), scoreColor(smoothed), "3.25rem");
      const orig = timed[p].i; // record best in MOVE order
      if (smoothed > peaksRef.current[orig]) peaksRef.current[orig] = smoothed;
      if (holdBarRef.current)
        holdBarRef.current.style.width = `${Math.round(r.passProgress * 100)}%`;
    });

  // Show the active checkpoint's pose as a ghost on the webcam.
  useEffect(() => {
    ghostRef.current =
      activeSorted >= 0 ? (timed[activeSorted].cp.keypoints ?? null) : null;
  }, [activeSorted, timed, ghostRef]);

  // Create the YouTube player once (IFrame API, privacy host). Scoring stays in
  // "loading" until onReady fires.
  useEffect(() => {
    let cancelled = false;
    let player: YTPlayer | null = null;
    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !playerHostRef.current) return;
        player = new YT.Player(playerHostRef.current, {
          host: "https://www.youtube-nocookie.com",
          videoId,
          playerVars: { playsinline: 1, modestbranding: 1, rel: 0 },
          events: {
            onReady: () => {
              if (cancelled) return;
              playerRef.current = player;
              if (phaseRef.current === "loading") setPhaseBoth("prestart");
            },
            onStateChange: (e) => {
              if (cancelled) return;
              const s = e.data;
              if (s === YT.PlayerState.PAUSED || s === YT.PlayerState.BUFFERING)
                pausedRef.current = true;
              else if (s === YT.PlayerState.PLAYING) pausedRef.current = false;
              else if (s === YT.PlayerState.ENDED) finish();
            },
          },
        });
      })
      .catch(() => {
        /* offline / API blocked — Start stays disabled */
      });
    return () => {
      cancelled = true;
      try {
        player?.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  function start() {
    if (phaseRef.current !== "prestart" || !readyToStart) return;
    finishedRef.current = false;
    setPhaseBoth("running");
    try {
      playerRef.current?.playVideo();
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      style={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        alignItems: "center",
      }}
    >
      <div style={{ width: "100%", textAlign: "center" }}>
        <div style={{ fontSize: "1.35rem", fontWeight: 700 }}>{move.name}</div>
        <div style={{ color: "#888", marginTop: 2 }}>
          Dance along with the video
          {phase === "running" && activeLabel && (
            <>
              {" · "}
              <span style={{ color: "#22d3ee", fontWeight: 600 }}>
                {activeLabel}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Demo video on top (IFrame Player API replaces this div). */}
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 9",
          background: "#000",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <div ref={playerHostRef} style={{ width: "100%", height: "100%" }} />
        {phase === "loading" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              background: "rgba(0,0,0,0.4)",
            }}
          >
            Loading video…
          </div>
        )}
      </div>

      {/* Webcam below, with the existing ghost overlay + full-body gate. */}
      <CameraStage
        videoRef={videoRef}
        canvasRef={canvasRef}
        ready={ready}
        error={error}
        errorKind={errorKind}
        onRetry={retry}
      >
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <div
            ref={scoreRef}
            data-testid="live-score"
            style={{
              fontWeight: 800,
              fontSize: "1.1rem",
              lineHeight: 1.1,
              color: "#aaa",
              padding: "10px 22px",
              borderRadius: 14,
              background: "rgba(0,0,0,0.45)",
              backdropFilter: "blur(4px)",
              textShadow: "0 2px 10px rgba(0,0,0,0.6)",
              textAlign: "center",
            }}
          >
            {phase === "running" ? "Get ready…" : "Step into frame to start"}
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            left: 16,
            right: 16,
            bottom: 14,
            height: 10,
            background: "rgba(0,0,0,0.55)",
            borderRadius: 5,
            overflow: "hidden",
          }}
        >
          <div
            ref={holdBarRef}
            style={{
              width: "0%",
              height: "100%",
              background: "#22c55e",
              transition: "width 60ms linear",
            }}
          />
        </div>
      </CameraStage>

      <div style={{ color: "#888", fontSize: "0.8rem" }}>
        <span style={{ color: "#ff40ff" }}>⬤</span> target pose ·{" "}
        <span style={{ color: "cyan" }}>⬤</span> you — hit each pose as the
        video reaches it
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        {phase !== "running" && phase !== "finished" && (
          <button
            onClick={start}
            data-testid="synced-start"
            disabled={phase !== "prestart" || !readyToStart}
            style={{
              padding: "12px 28px",
              fontSize: "1rem",
              fontWeight: 700,
              borderRadius: 8,
              border: "1px solid #14532d",
              background: phase === "prestart" && readyToStart ? "#16a34a" : "#1a1a1a",
              color: phase === "prestart" && readyToStart ? "#04130a" : "#666",
              cursor:
                phase === "prestart" && readyToStart ? "pointer" : "not-allowed",
            }}
          >
            {phase === "loading"
              ? "Loading…"
              : readyToStart
                ? "Start ▶"
                : "Step into frame…"}
          </button>
        )}
        <button onClick={onBack} style={{ ...btn, background: "#111" }}>
          Back to Moves
        </button>
      </div>
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
