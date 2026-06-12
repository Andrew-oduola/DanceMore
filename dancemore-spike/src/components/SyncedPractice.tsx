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
  type FrameOutcome,
} from "@/lib/practiceScore";
import { loadYouTubeApi, type YTPlayer } from "@/lib/youtube";

type Phase = "loading" | "prestart" | "running" | "finished";

// Split-screen practice: the YouTube demo plays on top while the webcam scores
// below. Layout is identical in both modes; scoring is the EXACT shared core
// (scoreCheckpointFrame — same gate, leg requirement, pass-through, thresholds).
//   • synced=true:  the video's playback TIME (never its pixels) selects the
//     active checkpoint window.
//   • synced=false: self-paced — the user advances by hitting each pose (or
//     Skip/Next); the video plays above purely as a visual reference.
export function SyncedPractice({
  move,
  synced,
  onFinish,
  onBack,
}: {
  move: Move;
  synced: boolean;
  onFinish: (peaks: number[]) => void;
  onBack: () => void;
}) {
  const videoId = validYoutubeId(move)!;
  const offset = move.videoOffset ?? 0;

  // Timestamped checkpoints, ascending by t, keeping their original indices so
  // the result breakdown stays in move order. (Only used when synced.)
  const timed = useMemo(
    () =>
      move.checkpoints
        .map((cp, i) => ({ cp, i }))
        .filter((x) => typeof x.cp.t === "number")
        .sort((a, b) => (a.cp.t as number) - (b.cp.t as number)),
    [move]
  );
  const sortedTs = useMemo(() => timed.map((x) => x.cp.t as number), [timed]);
  const lastWindowEnd =
    timed.length > 0 ? sortedTs[sortedTs.length - 1] + WINDOW_POST : 0;

  // Live, per-frame state kept out of React.
  const scoreRef = useRef<HTMLDivElement>(null);
  const holdBarRef = useRef<HTMLDivElement>(null);
  const peaksRef = useRef<number[]>(move.checkpoints.map(() => 0));
  const scoreBufRef = useRef<number[]>([]);
  const passStartRef = useRef<number | null>(null);
  const fullBodyRef = useRef(false);
  // synced: active position in `timed`. self-paced: sequential checkpoint index.
  const activeSortedRef = useRef<number>(-1);
  const indexRef = useRef(0);
  const advancingRef = useRef(false);

  const playerRef = useRef<YTPlayer | null>(null);
  const playerHostRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef<Phase>("loading");
  const pausedRef = useRef(false);
  const finishedRef = useRef(false);

  const [phase, setPhase] = useState<Phase>("loading");
  const [readyToStart, setReadyToStart] = useState(false);
  const [activeSorted, setActiveSorted] = useState(-1); // ghost driver (synced)
  const [index, setIndex] = useState(0); // ghost driver + label (self-paced)
  const setPhaseBoth = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  const label = synced
    ? activeSorted >= 0
      ? timed[activeSorted].cp.name
      : ""
    : `Pose ${index + 1} of ${move.checkpoints.length}`;

  function writeChip(text: string, color: string, size: string) {
    const el = scoreRef.current;
    if (!el) return;
    el.textContent = text;
    el.style.color = color;
    el.style.fontSize = size;
  }
  function setBar(pct: number) {
    if (holdBarRef.current)
      holdBarRef.current.style.width = `${Math.round(pct * 100)}%`;
  }

  // Apply a scoring outcome to the chip + bar, recording the best score into
  // `recordIndex` (the checkpoint's MOVE-order index).
  function renderOutcome(r: FrameOutcome, recordIndex: number) {
    if (r.state === "no-body") {
      writeChip(
        "Step back so we can see your whole body — legs included.",
        "#fbbf24",
        "0.95rem"
      );
      setBar(0);
      return;
    }
    if (r.state === "get-into-frame") {
      writeChip("Get into frame", "#aaa", "1.1rem");
      setBar(0);
      return;
    }
    const smoothed = r.smoothed as number;
    writeChip(String(smoothed), scoreColor(smoothed), "3.25rem");
    if (smoothed > peaksRef.current[recordIndex])
      peaksRef.current[recordIndex] = smoothed;
    setBar(r.passProgress);
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

  // Self-paced advance: hitting a pose (or Skip) moves to the next checkpoint.
  function advanceSelf() {
    if (advancingRef.current) return;
    advancingRef.current = true;
    if (indexRef.current + 1 < move.checkpoints.length) {
      indexRef.current += 1;
      setIndex(indexRef.current);
    } else {
      finish();
    }
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
        setBar(0);
        return;
      }

      if (synced) {
        const player = playerRef.current;
        if (!player) return;
        const vt = player.getCurrentTime() + offset;
        if (vt >= lastWindowEnd) {
          finish();
          return;
        }
        const p = activeCheckpoint(sortedTs, vt);
        if (p === -1) {
          writeChip("Get ready…", "#888", "1.1rem");
          passStartRef.current = null;
          setBar(0);
          return;
        }
        if (p !== activeSortedRef.current) {
          activeSortedRef.current = p;
          scoreBufRef.current = [];
          passStartRef.current = null;
          setActiveSorted(p);
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
        renderOutcome(r, timed[p].i);
        return;
      }

      // Self-paced: score the current checkpoint; a pass advances.
      const i = indexRef.current;
      const r = scoreCheckpointFrame(
        kp,
        angles,
        move.checkpoints[i].angles,
        scoreBufRef.current,
        passStartRef.current,
        performance.now()
      );
      passStartRef.current = r.passStart;
      renderOutcome(r, i);
      if (r.passed) advanceSelf();
    });

  // Show the active checkpoint's pose as a ghost on the webcam.
  useEffect(() => {
    const cp = synced
      ? activeSorted >= 0
        ? timed[activeSorted].cp
        : null
      : move.checkpoints[index];
    ghostRef.current = cp?.keypoints ?? null;
  }, [synced, activeSorted, index, timed, move, ghostRef]);

  // Self-paced: reset per-checkpoint live state when the checkpoint changes.
  useEffect(() => {
    if (synced) return;
    advancingRef.current = false;
    passStartRef.current = null;
    scoreBufRef.current = [];
    setBar(0);
  }, [index, synced]);

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
              // Only the synced timeline ends the attempt on video end; in
              // self-paced the video is just a reference.
              else if (s === YT.PlayerState.ENDED && synced) finish();
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

  const running = phase === "running";

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
          {running && label && (
            <>
              {" · "}
              <span style={{ color: "#22d3ee", fontWeight: 600 }}>{label}</span>
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
            {running ? "Get ready…" : "Step into frame to start"}
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
        <span style={{ color: "cyan" }}>⬤</span> you —{" "}
        {synced
          ? "hit each pose as the video reaches it"
          : "hit each pose to advance; the video is your reference"}
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        {!running && phase !== "finished" && (
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
              background:
                phase === "prestart" && readyToStart ? "#16a34a" : "#1a1a1a",
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
        {/* Self-paced keeps the manual Skip / Next so a move is never stuck. */}
        {running && !synced && (
          <button onClick={advanceSelf} data-testid="skip-next" style={btn}>
            Skip / Next
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
