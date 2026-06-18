"use client";

import { useEffect, useRef, useState } from "react";
import { usePoseDetection } from "@/hooks/usePoseDetection";
import { CameraStage } from "@/components/CameraStage";
import { createFullBodyGate } from "@/lib/bodyGate";
import { scoreColor } from "@/lib/scoreColor";
import { validYoutubeId, type Move } from "@/lib/moves";
import {
  createMovementScorer,
  REGIONS,
  REGION_LABEL,
  type MovementFrame,
  type MovementResult,
  type Region,
} from "@/lib/movementScore";
import { loadYouTubeApi, type YTPlayer } from "@/lib/youtube";

type Phase = "loading" | "prestart" | "countdown" | "running" | "finished";

// Auto-start, identical in feel to SyncedPractice: once the player is ready and
// the full body has been stably in frame for STABLE_MS, count down then start —
// no button (reaching one pulls the legs out of frame).
const STABLE_MS = 1000;
const COUNTDOWN_SECS = 3;

// Distinct accent per region so the indicators read at a glance.
const REGION_COLOR: Record<Region, string> = {
  head: "#f59e0b",
  arms: "#22d3ee",
  torso: "#a78bfa",
  legs: "#4ade80",
};

// Movement mode: the YouTube clip plays on top purely as background/inspiration
// while the webcam below scores the user's OWN whole-body movement (see
// lib/movementScore.ts — a separate path from checkpoint/synced scoring). Same
// split-screen layout, full-body gate, auto-start, and viewport fit as
// SyncedPractice; only the scoring function and the live display differ.
export function MovementPractice({
  move,
  onFinish,
  onBack,
}: {
  move: Move;
  onFinish: (result: MovementResult) => void;
  onBack: () => void;
}) {
  const videoId = validYoutubeId(move)!;

  // Live, per-frame state kept out of React (updated imperatively each frame).
  const scorerRef = useRef(createMovementScorer());
  const scoreRef = useRef<HTMLDivElement>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const regionRefs = useRef<Record<Region, HTMLDivElement | null>>({
    head: null,
    arms: null,
    torso: null,
    legs: null,
  });

  const playerRef = useRef<YTPlayer | null>(null);
  const playerHostRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef<Phase>("loading");
  const pausedRef = useRef(false);
  const finishedRef = useRef(false);

  // Auto-start bookkeeping — same stable, hysteretic gate SyncedPractice uses so
  // the prompt doesn't chatter and the countdown isn't cancelled by a blip.
  const fullBodyGateRef = useRef(createFullBodyGate());
  const stableStartRef = useRef<number | null>(null);
  const countdownStartRef = useRef<number | null>(null);
  const lastBeepRef = useRef(0);
  const audioRef = useRef<AudioContext | null>(null);

  const [phase, setPhase] = useState<Phase>("loading");
  const [countdownNum, setCountdownNum] = useState<number | null>(null);
  const setPhaseBoth = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  // A short Web Audio tone for the countdown beeps + the go tone (no assets).
  function tone(freq: number, durationMs: number, type: OscillatorType = "sine") {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return;
      const ctx = audioRef.current ?? (audioRef.current = new Ctx());
      if (ctx.state === "suspended") void ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + durationMs / 1000);
      osc.start(t);
      osc.stop(t + durationMs / 1000 + 0.02);
    } catch {
      /* audio is a nicety; never let it block start */
    }
  }

  function beginRun() {
    if (phaseRef.current === "running") return;
    finishedRef.current = false;
    stableStartRef.current = null;
    countdownStartRef.current = null;
    setCountdownNum(null);
    scorerRef.current.reset(); // don't count any pre-start jitter
    setPhaseBoth("running");
    try {
      playerRef.current?.playVideo();
    } catch {
      /* ignore */
    }
  }

  function writeChip(text: string, color: string, size: string) {
    const el = scoreRef.current;
    if (!el) return;
    el.textContent = text;
    el.style.color = color;
    el.style.fontSize = size;
  }
  function setMeter(pct: number) {
    if (meterRef.current)
      meterRef.current.style.width = `${Math.round(Math.min(1, pct) * 100)}%`;
  }
  function setRegions(frame: MovementFrame | null) {
    for (const r of REGIONS) {
      const el = regionRefs.current[r];
      if (!el) continue;
      const live = frame?.regions[r];
      const active = live?.active ?? false;
      const intensity = live?.intensity ?? 0;
      el.style.background = active ? REGION_COLOR[r] : "rgba(255,255,255,0.08)";
      el.style.color = active ? "#0a0a0a" : "#888";
      el.style.borderColor = active ? REGION_COLOR[r] : "#333";
      el.style.opacity = String(active ? 0.55 + 0.45 * intensity : 0.6);
    }
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
    onFinish(scorerRef.current.result());
  }

  const { videoRef, canvasRef, ready, error, errorKind, retry } =
    usePoseDetection((kp) => {
      const now = performance.now();
      // Advance the stable gate every frame so its debounce stays continuous.
      const full = fullBodyGateRef.current.update(kp, now);

      // Auto-start (prompt → stable → countdown → run), mirroring SyncedPractice.
      if (phaseRef.current === "prestart" || phaseRef.current === "countdown") {
        if (!full) {
          stableStartRef.current = null;
          if (phaseRef.current === "countdown") {
            setPhaseBoth("prestart");
            countdownStartRef.current = null;
            setCountdownNum(null);
          }
          writeChip(
            "Step back so we can see your whole body — legs included.",
            "#fbbf24",
            "0.95rem"
          );
          return;
        }

        if (stableStartRef.current === null) stableStartRef.current = now;

        if (phaseRef.current === "prestart") {
          if (now - stableStartRef.current < STABLE_MS) {
            writeChip("Hold still — starting…", "#4ade80", "1.1rem");
            return;
          }
          setPhaseBoth("countdown");
          countdownStartRef.current = now;
          lastBeepRef.current = COUNTDOWN_SECS + 1;
        }

        const remaining = Math.ceil(
          COUNTDOWN_SECS - (now - (countdownStartRef.current as number)) / 1000
        );
        if (remaining > 0) {
          if (remaining < lastBeepRef.current) {
            lastBeepRef.current = remaining;
            setCountdownNum(remaining);
            tone(880, 120);
          }
          writeChip("Get ready to move…", "#fff", "1.1rem");
          return;
        }
        tone(1320, 260, "square");
        beginRun();
        return;
      }

      if (phaseRef.current !== "running") return;

      if (pausedRef.current) {
        writeChip("Paused", "#aaa", "1.1rem");
        setMeter(0);
        setRegions(null);
        return;
      }

      const r = scorerRef.current.frame(kp, now);
      if (r.state === "no-body") {
        writeChip(
          "Step back so we can see your whole body — legs included.",
          "#fbbf24",
          "0.95rem"
        );
        setMeter(0);
        setRegions(null);
        return;
      }
      if (r.state === "get-ready") {
        writeChip("Start moving!", "#aaa", "1.4rem");
        setMeter(0);
        setRegions(r);
        return;
      }
      writeChip(String(r.score), scoreColor(r.score), "3.25rem");
      setMeter(r.intensity);
      setRegions(r);
    });

  // Create the YouTube player once. Scoring stays in "loading" until onReady.
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
              // Background clip ended → wrap the session up on the final score.
              else if (s === YT.PlayerState.ENDED) finish();
            },
          },
        });
      })
      .catch(() => {
        /* offline / API blocked — auto-start simply never fires */
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

  // Release the audio context on unmount.
  useEffect(() => () => void audioRef.current?.close(), []);

  const running = phase === "running";

  // One viewport tall, no scrolling — the same fixed flex column SyncedPractice
  // uses: two media panels split the height and scale DOWN to fit.
  return (
    <div
      className="practice-fit"
      data-testid="movement-practice"
      data-phase={phase}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 8,
        overflow: "hidden",
        background: "var(--background)",
      }}
    >
      {/* Slim header: title + freestyle tag + Back / Finish. */}
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: "0.85rem",
          minWidth: 0,
        }}
      >
        <span className="wordmark" style={{ fontSize: "1rem", flex: "0 0 auto" }}>
          DanceMore
        </span>
        <span
          style={{
            color: "#bbb",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
            flex: 1,
          }}
        >
          {move.name}
          <span style={{ color: "#22d3ee", fontWeight: 600 }}> · Freestyle</span>
        </span>
        {running && (
          <button
            onClick={finish}
            data-testid="movement-finish"
            style={{ ...btn, flex: "0 0 auto", padding: "6px 12px", fontSize: "0.82rem" }}
          >
            Finish
          </button>
        )}
        <button
          onClick={onBack}
          style={{ ...btn, flex: "0 0 auto", padding: "6px 12px", fontSize: "0.82rem" }}
        >
          ← Back
        </button>
      </div>

      {/* Video panel (top) — plays as background; scales down to fit. */}
      <div
        style={{
          flex: "1 1 0",
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          className="yt-fit"
          style={{
            position: "relative",
            height: "100%",
            width: "auto",
            maxWidth: "100%",
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
      </div>

      {/* Webcam panel (bottom) — live score, movement meter, region indicators. */}
      <div
        style={{
          flex: "1 1 0",
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <CameraStage
          videoRef={videoRef}
          canvasRef={canvasRef}
          ready={ready}
          error={error}
          errorKind={errorKind}
          onRetry={retry}
          containerStyle={{
            width: "auto",
            height: "100%",
            maxWidth: "100%",
            aspectRatio: "4 / 3",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 10,
              left: 0,
              right: 0,
              display: "flex",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <div
              ref={scoreRef}
              data-testid="movement-score"
              style={{
                fontWeight: 800,
                fontSize: "1.1rem",
                lineHeight: 1.1,
                color: "#aaa",
                padding: "8px 18px",
                borderRadius: 14,
                background: "rgba(0,0,0,0.45)",
                backdropFilter: "blur(4px)",
                textShadow: "0 2px 10px rgba(0,0,0,0.6)",
                textAlign: "center",
              }}
            >
              {running ? "Start moving!" : "Step into frame to start"}
            </div>
          </div>

          {/* Big auto-start countdown, readable from across the room. */}
          {countdownNum !== null && (
            <div
              data-testid="countdown"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
              }}
            >
              <span
                style={{
                  fontSize: "6rem",
                  fontWeight: 800,
                  color: "#fff",
                  lineHeight: 1,
                  textShadow: "0 4px 24px rgba(0,0,0,0.8)",
                }}
              >
                {countdownNum}
              </span>
            </div>
          )}

          {/* Region indicators — light up as each body region engages. */}
          <div
            style={{
              position: "absolute",
              left: 16,
              right: 16,
              bottom: 30,
              display: "flex",
              gap: 8,
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            {REGIONS.map((r) => (
              <div
                key={r}
                ref={(el) => {
                  regionRefs.current[r] = el;
                }}
                data-testid={`region-${r}`}
                style={{
                  flex: "0 1 auto",
                  fontSize: "0.72rem",
                  fontWeight: 700,
                  padding: "4px 10px",
                  borderRadius: 999,
                  border: "1px solid #333",
                  background: "rgba(255,255,255,0.08)",
                  color: "#888",
                  opacity: 0.6,
                  transition: "background 80ms linear, opacity 80ms linear",
                }}
              >
                {REGION_LABEL[r]}
              </div>
            ))}
          </div>

          {/* Live movement meter. */}
          <div
            style={{
              position: "absolute",
              left: 16,
              right: 16,
              bottom: 12,
              height: 8,
              background: "rgba(0,0,0,0.55)",
              borderRadius: 5,
              overflow: "hidden",
            }}
          >
            <div
              ref={meterRef}
              style={{
                width: "0%",
                height: "100%",
                background: "linear-gradient(90deg, #22d3ee, #4ade80)",
                transition: "width 80ms linear",
              }}
            />
          </div>
        </CameraStage>
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
