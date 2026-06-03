"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { scorePose } from "@/lib/pose";
import { loadMoves, type Move } from "@/lib/moves";
import { usePoseDetection } from "@/hooks/usePoseDetection";
import { CameraStage } from "@/components/CameraStage";
import { scoreColor } from "@/lib/scoreColor";
import {
  clearToken,
  getStats,
  getToken,
  saveAttempt,
  subscribeToken,
} from "@/lib/api";
import { AuthScreen } from "@/components/AuthScreen";
import { Dashboard } from "@/components/Dashboard";
import { WarmupChecklist } from "@/components/WarmupChecklist";

// ── Demo-feel dials ─────────────────────────────────────────────────────────
// Pass when the live score holds >= PASS_THRESHOLD continuously for HOLD_MS.
const PASS_THRESHOLD = 70;
const HOLD_MS = 800;
const SMOOTH_WINDOW = 10; // frames of score smoothing, as in the spike
const REST_THRESHOLD = 6; // suggest a rest day at this many consecutive days
const WARMUP_KEY = "dancemore_warmedUpDate";

type View =
  | { kind: "library" }
  | { kind: "warmup"; move: Move }
  | { kind: "practice"; move: Move }
  | { kind: "result"; move: Move; peaks: number[] }
  | { kind: "dashboard" };

export default function Page() {
  const [moves, setMoves] = useState<Move[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "library" });

  // Auth state derives from the token in localStorage (an external store).
  // Server snapshot is null, so prerendered HTML shows the login screen until
  // hydration reads the real token.
  const token = useSyncExternalStore(subscribeToken, getToken, () => null);
  const authed = token !== null;

  useEffect(() => {
    loadMoves()
      .then(setMoves)
      .catch((e) =>
        setLoadError(e instanceof Error ? e.message : String(e))
      );
  }, []);

  // Rest-day nudge: fetch the streak once per login; dismiss for the session.
  const [streak, setStreak] = useState(0);
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    getStats()
      .then((s) => {
        if (!cancelled) setStreak(s.current_streak);
      })
      .catch(() => {}); // banner is best-effort; never block the app
    return () => {
      cancelled = true;
    };
  }, [authed]);
  const showNudge =
    authed &&
    !nudgeDismissed &&
    streak >= REST_THRESHOLD &&
    (view.kind === "library" || view.kind === "dashboard");

  // Warmup: gate the FIRST practice of a calendar day; skipping holds for the
  // rest of the browser session.
  const warmupSkippedRef = useRef(false);
  function startMove(move: Move) {
    const warmedUpToday =
      typeof window !== "undefined" &&
      localStorage.getItem(WARMUP_KEY) === new Date().toDateString();
    if (warmedUpToday || warmupSkippedRef.current) {
      setView({ kind: "practice", move });
    } else {
      setView({ kind: "warmup", move });
    }
  }

  function logout() {
    clearToken(); // emits a token change; authed recomputes to false
    setView({ kind: "library" });
    setStreak(0);
    setNudgeDismissed(false);
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
      {/* Header only when signed in — the login screen has its own landing. */}
      {authed && (
        <div
          style={{
            width: "100%",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
          }}
        >
          <h1 className="wordmark" style={{ fontSize: "1.6rem", margin: 0 }}>
            DanceMore
          </h1>
          <nav style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => setView({ kind: "library" })}
              style={navBtn(view.kind !== "dashboard")}
            >
              Library
            </button>
            <button
              onClick={() => setView({ kind: "dashboard" })}
              style={navBtn(view.kind === "dashboard")}
            >
              Dashboard
            </button>
            <button onClick={logout} style={navBtn(false)}>
              Logout
            </button>
          </nav>
        </div>
      )}

      {!authed && (
        <AuthScreen onSuccess={() => setView({ kind: "library" })} />
      )}

      {showNudge && (
        <RestDayBanner
          streak={streak}
          onDismiss={() => setNudgeDismissed(true)}
        />
      )}

      {authed && view.kind === "dashboard" && <Dashboard />}

      {authed && view.kind === "library" && (
        <Library moves={moves} loadError={loadError} onPick={startMove} />
      )}

      {authed && view.kind === "warmup" && (
        <WarmupChecklist
          onStart={() => {
            localStorage.setItem(WARMUP_KEY, new Date().toDateString());
            setView({ kind: "practice", move: view.move });
          }}
          onSkip={() => {
            warmupSkippedRef.current = true;
            setView({ kind: "practice", move: view.move });
          }}
        />
      )}

      {authed && view.kind === "practice" && (
        <Practice
          key={view.move.id}
          move={view.move}
          onFinish={(peaks) =>
            setView({ kind: "result", move: view.move, peaks })
          }
          onBack={() => setView({ kind: "library" })}
        />
      )}

      {authed && view.kind === "result" && (
        <Result
          move={view.move}
          peaks={view.peaks}
          onRetry={() => setView({ kind: "practice", move: view.move })}
          onBack={() => setView({ kind: "library" })}
        />
      )}
    </main>
  );
}

// ── REST-DAY NUDGE ──────────────────────────────────────────────────────────
function RestDayBanner({
  streak,
  onDismiss,
}: {
  streak: number;
  onDismiss: () => void;
}) {
  return (
    <div
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 16px",
        borderRadius: 8,
        border: "1px solid #78350f",
        background: "#1c1306",
        color: "#fbbf24",
      }}
    >
      <span style={{ flex: 1, fontSize: "0.9rem", lineHeight: 1.4 }}>
        You’ve trained {streak} days in a row 🔥 — consider a rest day.
        Recovery prevents injury and improves performance.
      </span>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          background: "none",
          border: "none",
          color: "#fbbf24",
          cursor: "pointer",
          fontSize: "1rem",
          padding: 4,
          lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}

// ── LIBRARY ─────────────────────────────────────────────────────────────────
function Library({
  moves,
  loadError,
  onPick,
}: {
  moves: Move[] | null;
  loadError: string | null;
  onPick: (move: Move) => void;
}) {
  if (loadError)
    return <p style={{ color: "#ef4444" }}>Couldn’t load moves: {loadError}</p>;
  if (!moves) return <p style={{ color: "#888" }}>Loading moves…</p>;

  return (
    <>
      <p style={{ color: "#888", margin: 0 }}>Pick a move to practice.</p>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          width: "100%",
        }}
      >
        {moves.map((move) => (
          <button
            key={move.id}
            className="moveCard"
            onClick={() => onPick(move)}
            style={{
              ...card,
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
              }}
            >
              <span style={{ fontSize: "1.15rem", fontWeight: 700 }}>
                {move.name}
              </span>
              <span style={{ color: "#22d3ee", fontSize: "0.85rem" }}>
                Practice →
              </span>
            </div>
            <div style={{ color: "#888", fontSize: "0.9rem" }}>
              {move.checkpoints.length} poses
            </div>
          </button>
        ))}
      </div>
      <Link
        href="/author"
        style={{ color: "#666", fontSize: "0.85rem", marginTop: 8 }}
      >
        Author tool →
      </Link>
    </>
  );
}

// ── PRACTICE ────────────────────────────────────────────────────────────────
function Practice({
  move,
  onFinish,
  onBack,
}: {
  move: Move;
  onFinish: (peaks: number[]) => void;
  onBack: () => void;
}) {
  const [index, setIndex] = useState(0);
  const checkpoint = move.checkpoints[index];

  // Live, per-frame state kept out of React to avoid reconciling every frame.
  const scoreRef = useRef<HTMLDivElement>(null);
  const holdBarRef = useRef<HTMLDivElement>(null);
  const bestRef = useRef<HTMLDivElement>(null);

  const peaksRef = useRef<number[]>(move.checkpoints.map(() => 0));
  const scoreBufRef = useRef<number[]>([]);
  const holdStartRef = useRef<number | null>(null);
  const advancingRef = useRef(false);

  // Reset per-checkpoint live state whenever we move to a new checkpoint.
  useEffect(() => {
    advancingRef.current = false;
    holdStartRef.current = null;
    scoreBufRef.current = [];
    if (holdBarRef.current) holdBarRef.current.style.width = "0%";
    if (bestRef.current) bestRef.current.textContent = "Best: 0";
    if (scoreRef.current) {
      scoreRef.current.textContent = "Get into frame";
      scoreRef.current.style.color = "#aaa";
      scoreRef.current.style.fontSize = "1.1rem";
    }
  }, [index]);

  function advance() {
    if (advancingRef.current) return;
    advancingRef.current = true;
    if (index + 1 < move.checkpoints.length) {
      setIndex(index + 1);
    } else {
      onFinish([...peaksRef.current]);
    }
  }

  const { videoRef, canvasRef, ready, error } = usePoseDetection(
    (_kp, angles) => {
      const raw = scorePose(checkpoint.angles, angles);

      // Smooth the score over a short window (mirrors the spike).
      let smoothed: number | null = null;
      if (raw !== null) {
        const buf = scoreBufRef.current;
        buf.push(raw);
        if (buf.length > SMOOTH_WINDOW) buf.shift();
        smoothed = Math.round(buf.reduce((s, v) => s + v, 0) / buf.length);
      }

      const el = scoreRef.current;
      if (smoothed === null) {
        // Fewer than 4 shared joints visible — can't judge.
        if (el) {
          el.textContent = "Get into frame";
          el.style.color = "#aaa";
          el.style.fontSize = "1.1rem";
        }
        holdStartRef.current = null;
        if (holdBarRef.current) holdBarRef.current.style.width = "0%";
        return;
      }

      if (el) {
        el.textContent = String(smoothed);
        el.style.fontSize = "3.25rem";
        el.style.color = scoreColor(smoothed);
      }

      // Track the peak (best) score reached for this checkpoint.
      if (smoothed > peaksRef.current[index]) {
        peaksRef.current[index] = smoothed;
        if (bestRef.current) bestRef.current.textContent = `Best: ${smoothed}`;
      }

      // Hold-to-pass: lock the checkpoint once the score stays at/above the
      // threshold continuously for HOLD_MS.
      const now = performance.now();
      if (smoothed >= PASS_THRESHOLD) {
        if (holdStartRef.current === null) holdStartRef.current = now;
        const held = now - holdStartRef.current;
        if (holdBarRef.current) {
          holdBarRef.current.style.width = `${Math.min(
            100,
            (held / HOLD_MS) * 100
          )}%`;
        }
        if (held >= HOLD_MS) advance();
      } else {
        holdStartRef.current = null;
        if (holdBarRef.current) holdBarRef.current.style.width = "0%";
      }
    }
  );

  return (
    <>
      <div style={{ width: "100%", textAlign: "center" }}>
        <div style={{ fontSize: "1.35rem", fontWeight: 700 }}>{move.name}</div>
        <div style={{ color: "#888", marginTop: 2 }}>
          Pose {index + 1} of {move.checkpoints.length} ·{" "}
          <span style={{ color: "#22d3ee", fontWeight: 600 }}>
            {checkpoint.name}
          </span>
        </div>
      </div>

      {/* The camera is the hero: live score chip + hold bar live on top of it,
          all driven via DOM refs (no per-frame React state). */}
      <CameraStage
        videoRef={videoRef}
        canvasRef={canvasRef}
        ready={ready}
        error={error}
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
            }}
          >
            Get into frame
          </div>
        </div>

        {/* Hold-to-pass progress, anchored to the bottom of the camera. */}
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

      <div ref={bestRef} style={{ color: "#888", fontSize: "0.9rem" }}>
        Best: 0
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        <button onClick={advance} style={btn}>
          Skip / Next
        </button>
        <button onClick={onBack} style={{ ...btn, background: "#111" }}>
          Back to Moves
        </button>
      </div>
    </>
  );
}

// ── RESULT ──────────────────────────────────────────────────────────────────
function Result({
  move,
  peaks,
  onRetry,
  onBack,
}: {
  move: Move;
  peaks: number[];
  onRetry: () => void;
  onBack: () => void;
}) {
  const overall =
    peaks.length > 0
      ? Math.round(peaks.reduce((s, v) => s + v, 0) / peaks.length)
      : 0;

  // Save the attempt once on arrival (ref-guarded against StrictMode's
  // double-mounted dev effects).
  const [saveState, setSaveState] = useState<"saving" | "saved" | "failed">(
    "saving"
  );
  const postedRef = useRef(false);
  useEffect(() => {
    if (postedRef.current) return;
    postedRef.current = true;
    saveAttempt({
      move_id: move.id,
      move_name: move.name,
      overall_score: overall,
      checkpoint_scores: move.checkpoints.map((cp, i) => ({
        name: cp.name,
        score: peaks[i] ?? 0,
      })),
    })
      .then(() => setSaveState("saved"))
      .catch(() => setSaveState("failed"));
  }, [move, peaks, overall]);

  return (
    <>
      <div style={{ fontSize: "1.25rem", fontWeight: 700 }}>{move.name}</div>
      <div style={{ color: "#888" }}>Overall score</div>
      <div
        style={{
          fontSize: "5rem",
          fontWeight: 700,
          color: scoreColor(overall),
          lineHeight: 1,
        }}
      >
        {overall}
      </div>

      <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
        {move.checkpoints.map((cp, i) => (
          <div
            key={i}
            style={{
              ...card,
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>
              {i + 1}. {cp.name}
            </span>
            <span style={{ fontWeight: 700, color: scoreColor(peaks[i] ?? 0) }}>
              {peaks[i] ?? 0}
            </span>
          </div>
        ))}
      </div>

      <div
        style={{
          fontSize: "0.85rem",
          color:
            saveState === "saved"
              ? "#22c55e"
              : saveState === "failed"
                ? "#ef4444"
                : "#888",
        }}
      >
        {saveState === "saving" && "Saving attempt…"}
        {saveState === "saved" && "Attempt saved ✓"}
        {saveState === "failed" && "Couldn’t save attempt"}
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        <button onClick={onRetry} style={btn}>
          Try Again
        </button>
        <button onClick={onBack} style={{ ...btn, background: "#111" }}>
          Back to Moves
        </button>
      </div>
    </>
  );
}

const navBtn = (active: boolean): React.CSSProperties => ({
  padding: "6px 12px",
  fontSize: "0.85rem",
  fontWeight: 600,
  borderRadius: 6,
  border: "1px solid #444",
  background: active ? "#1a1a1a" : "transparent",
  color: active ? "#fff" : "#888",
  cursor: "pointer",
});

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

const card: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "14px 16px",
  borderRadius: 8,
  border: "1px solid #333",
  background: "#1a1a1a",
  color: "#fff",
  width: "100%",
};
