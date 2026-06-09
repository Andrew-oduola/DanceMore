"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Link from "next/link";
import { scorePose } from "@/lib/pose";
import { loadMoves, validYoutubeId, type Move } from "@/lib/moves";
import { hasFullBody, passHasLegs } from "@/lib/bodyGate";
import { usePoseDetection } from "@/hooks/usePoseDetection";
import { CameraStage } from "@/components/CameraStage";
import { scoreColor } from "@/lib/scoreColor";
import {
  clearToken,
  getStats,
  getToken,
  saveAttempt,
  subscribeToken,
  type Stats,
} from "@/lib/api";
import { AuthScreen } from "@/components/AuthScreen";
import { Dashboard } from "@/components/Dashboard";
import { WarmupChecklist } from "@/components/WarmupChecklist";
import { UploadMove } from "@/components/UploadMove";

// ── Demo-feel dials ─────────────────────────────────────────────────────────
// Pass when the live score holds >= PASS_THRESHOLD continuously for HOLD_MS.
const PASS_THRESHOLD = 70;
const HOLD_MS = 800;
const SMOOTH_WINDOW = 10; // frames of score smoothing, as in the spike
const REST_THRESHOLD = 6; // suggest a rest day at this many consecutive days
const COMPLETE_THRESHOLD = 80; // a move is "completed" once its best score crosses this
const WARMUP_KEY = "dancemore_warmedUpDate";

type View =
  | { kind: "library" }
  | { kind: "upload" }
  | { kind: "watch"; move: Move }
  | { kind: "warmup"; move: Move }
  | { kind: "practice"; move: Move }
  | { kind: "result"; move: Move; peaks: number[]; firstCompletion: boolean }
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

  // Session-uploaded moves (object-URL backed; gone on reload by design).
  const [uploadedMoves, setUploadedMoves] = useState<Move[]>([]);
  const allMoves = useMemo(
    () => (moves ? [...moves, ...uploadedMoves] : null),
    [moves, uploadedMoves]
  );
  const uploadedIds = useMemo(
    () => new Set(uploadedMoves.map((m) => m.id)),
    [uploadedMoves]
  );

  // Stats power the rest-day nudge, completion badges, and the celebration's
  // "prior best". Refetched on every Library/Dashboard entry so badges update
  // after each saved attempt; the snapshot taken before practice is what
  // "already completed?" is judged against.
  const [stats, setStats] = useState<Stats | null>(null);
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  useEffect(() => {
    if (!authed) return;
    if (view.kind !== "library" && view.kind !== "dashboard") return;
    let cancelled = false;
    getStats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {}); // best-effort; never block the app
    return () => {
      cancelled = true;
    };
  }, [authed, view.kind]);

  const streak = stats?.current_streak ?? 0;
  const bestScores = useMemo(() => {
    const map: Record<string, number> = {};
    for (const m of stats?.moves ?? []) map[m.move_id] = m.best_score;
    return map;
  }, [stats]);
  // Moves celebrated this session — guards against re-triggering on "Try
  // Again" before the stats snapshot refreshes.
  const celebratedRef = useRef<Set<string>>(new Set());

  const showNudge =
    authed &&
    !nudgeDismissed &&
    streak >= REST_THRESHOLD &&
    (view.kind === "library" || view.kind === "dashboard");

  // Picking a move: Watch → Do → Get scored. Moves without any demo (YouTube
  // or self-hosted clip) skip the watch beat entirely.
  function startMove(move: Move) {
    if (validYoutubeId(move) || move.demoVideo) {
      setView({ kind: "watch", move });
    } else {
      proceedToPractice(move);
    }
  }

  // Warmup: gate the FIRST practice of a calendar day; skipping holds for the
  // rest of the browser session.
  const warmupSkippedRef = useRef(false);
  function proceedToPractice(move: Move) {
    const warmedUpToday =
      typeof window !== "undefined" &&
      localStorage.getItem(WARMUP_KEY) === new Date().toDateString();
    if (warmedUpToday || warmupSkippedRef.current) {
      setView({ kind: "practice", move });
    } else {
      setView({ kind: "warmup", move });
    }
  }

  // Logout asks for confirmation first; only confirming clears the session.
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  function logout() {
    setConfirmingLogout(false);
    clearToken(); // emits a token change; authed recomputes to false
    setView({ kind: "library" });
    setStats(null);
    setNudgeDismissed(false);
    celebratedRef.current.clear();
    // Uploaded moves are session-and-account scoped: drop them (and their
    // object URLs) so they don't appear as "Yours" to the next login.
    for (const m of uploadedMoves)
      if (m.demoVideo?.startsWith("blob:")) URL.revokeObjectURL(m.demoVideo);
    setUploadedMoves([]);
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
            <button
              onClick={() => setConfirmingLogout(true)}
              style={navBtn(false)}
            >
              Logout
            </button>
          </nav>
        </div>
      )}

      {confirmingLogout && (
        <div
          onClick={() => setConfirmingLogout(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.65)",
            padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            style={{
              width: "100%",
              maxWidth: 360,
              display: "flex",
              flexDirection: "column",
              gap: 16,
              padding: 24,
              borderRadius: 12,
              border: "1px solid #333",
              background: "#111",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>
              Are you sure you want to log out?
            </div>
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
              <button
                onClick={() => setConfirmingLogout(false)}
                style={{ ...btn, background: "#111" }}
              >
                Cancel
              </button>
              <button
                onClick={logout}
                style={{
                  ...btn,
                  background: "#7f1d1d",
                  border: "1px solid #991b1b",
                }}
              >
                Log out
              </button>
            </div>
          </div>
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

      {authed && view.kind === "dashboard" && (
        <Dashboard
          libraryMoveIds={(allMoves ?? []).map((m) => m.id)}
          completeThreshold={COMPLETE_THRESHOLD}
        />
      )}

      {authed && view.kind === "library" && (
        <Library
          moves={allMoves}
          loadError={loadError}
          onPick={startMove}
          onUpload={() => setView({ kind: "upload" })}
          bestScores={bestScores}
          completeThreshold={COMPLETE_THRESHOLD}
          uploadedIds={uploadedIds}
        />
      )}

      {authed && view.kind === "upload" && (
        <UploadMove
          onSave={(move) => {
            setUploadedMoves((prev) => [...prev, move]);
            setView({ kind: "library" });
          }}
          onCancel={() => setView({ kind: "library" })}
        />
      )}

      {authed && view.kind === "watch" && (
        <Watch
          move={view.move}
          onPractice={() => proceedToPractice(view.move)}
          onBack={() => setView({ kind: "library" })}
        />
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
          onFinish={(peaks) => {
            // First-completion is decided HERE, against the stats snapshot
            // taken before this attempt (plus a session guard so "Try Again"
            // can't re-trigger it before stats refresh).
            const overall =
              peaks.length > 0
                ? Math.round(peaks.reduce((s, v) => s + v, 0) / peaks.length)
                : 0;
            const priorBest = bestScores[view.move.id] ?? 0;
            const firstCompletion =
              overall >= COMPLETE_THRESHOLD &&
              priorBest < COMPLETE_THRESHOLD &&
              !celebratedRef.current.has(view.move.id);
            if (firstCompletion) celebratedRef.current.add(view.move.id);
            setView({ kind: "result", move: view.move, peaks, firstCompletion });
          }}
          onBack={() => setView({ kind: "library" })}
          onRewatch={
            view.move.demoVideo || validYoutubeId(view.move)
              ? () => setView({ kind: "watch", move: view.move })
              : undefined
          }
        />
      )}

      {authed && view.kind === "result" && (
        <Result
          move={view.move}
          peaks={view.peaks}
          firstCompletion={view.firstCompletion}
          onRetry={() => setView({ kind: "practice", move: view.move })}
          onBack={() => setView({ kind: "library" })}
        />
      )}

      <footer
        style={{
          marginTop: "auto",
          paddingTop: 24,
          color: "#555",
          fontSize: "0.72rem",
          textAlign: "center",
        }}
      >
        Some demo videos are embedded from YouTube in privacy-enhanced
        (no-cookie) mode. Your camera feed never leaves this device.
      </footer>
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

// ── WATCH ───────────────────────────────────────────────────────────────────
// The "learn it" beat: loop the demo clip with controls. No camera here —
// detection only spins up when PRACTICE mounts.
function Watch({
  move,
  onPractice,
  onBack,
}: {
  move: Move;
  onPractice: () => void;
  onBack: () => void;
}) {
  const [clipMissing, setClipMissing] = useState(false);
  // Precedence: YouTube embed → self-hosted clip → "coming soon" panel.
  // The YouTube iframe is WATCH-ONLY: cross-origin, never pose-analyzed —
  // scoring always uses the move's stored checkpoints.
  const youtubeId = validYoutubeId(move);

  return (
    <>
      <div style={{ width: "100%", textAlign: "center" }}>
        <div style={{ fontSize: "1.35rem", fontWeight: 700 }}>{move.name}</div>
        {move.description && (
          <div style={{ color: "#888", marginTop: 2 }}>{move.description}</div>
        )}
      </div>

      {youtubeId ? (
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
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${youtubeId}`}
            title={`${move.name} demo`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              border: 0,
            }}
          />
        </div>
      ) : (
        <div
          style={{
            position: "relative",
            width: "100%",
            aspectRatio: "4 / 3",
            background: "#000",
            borderRadius: 8,
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {!move.demoVideo || clipMissing ? (
            <div style={{ color: "#888", textAlign: "center", padding: 24 }}>
              <div style={{ fontSize: "2rem", marginBottom: 8 }}>🎬</div>
              Demo clip coming soon.
              {move.demoVideo && (
                <div style={{ fontSize: "0.8rem", color: "#555", marginTop: 6 }}>
                  ({move.demoVideo} not found)
                </div>
              )}
            </div>
          ) : (
            <video
              src={move.demoVideo}
              autoPlay
              muted
              loop
              controls
              playsInline
              onError={() => setClipMissing(true)}
              style={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
          )}
        </div>
      )}

      <button
        onClick={onPractice}
        style={{
          padding: "12px 28px",
          fontSize: "1rem",
          fontWeight: 700,
          borderRadius: 8,
          border: "1px solid #14532d",
          background: "#16a34a",
          color: "#04130a",
          cursor: "pointer",
        }}
      >
        Practice this move →
      </button>

      <div style={{ display: "flex", gap: 20 }}>
        <button
          onClick={onPractice}
          style={{
            background: "none",
            border: "none",
            color: "#666",
            cursor: "pointer",
            fontSize: "0.85rem",
          }}
        >
          Skip
        </button>
        <button
          onClick={onBack}
          style={{
            background: "none",
            border: "none",
            color: "#666",
            cursor: "pointer",
            fontSize: "0.85rem",
          }}
        >
          Back to Moves
        </button>
      </div>
    </>
  );
}

// ── LIBRARY ─────────────────────────────────────────────────────────────────
function Library({
  moves,
  loadError,
  onPick,
  onUpload,
  bestScores,
  completeThreshold,
  uploadedIds,
}: {
  moves: Move[] | null;
  loadError: string | null;
  onPick: (move: Move) => void;
  onUpload: () => void;
  bestScores: Record<string, number>;
  completeThreshold: number;
  uploadedIds: Set<string>;
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
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: "#888",
                fontSize: "0.9rem",
              }}
            >
              <span>{move.checkpoints.length} poses</span>
              {(move.demoVideo || validYoutubeId(move)) && (
                <span style={chip("#22d3ee", "#164e63")}>▶ Watch</span>
              )}
              {uploadedIds.has(move.id) && (
                <span style={chip("#a78bfa", "#4c1d95")}>Yours</span>
              )}
              {(bestScores[move.id] ?? 0) >= completeThreshold && (
                <span style={chip("#4ade80", "#14532d")}>✓ Completed</span>
              )}
            </div>
          </button>
        ))}

        {/* Upload entry — turns any clip into a practicable move. */}
        <button
          className="moveCard"
          onClick={onUpload}
          style={{
            ...card,
            textAlign: "center",
            cursor: "pointer",
            border: "2px dashed #333",
            background: "transparent",
            color: "#888",
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: "1.05rem", fontWeight: 700 }}>
            ⬆ Upload a dance
          </span>
          <span style={{ fontSize: "0.85rem" }}>
            We’ll extract its key poses so you can practice it
          </span>
        </button>
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
  onRewatch,
}: {
  move: Move;
  onFinish: (peaks: number[]) => void;
  onBack: () => void;
  onRewatch?: () => void;
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

  const { videoRef, canvasRef, ready, error, errorKind, retry, ghostRef } =
    usePoseDetection((kp, angles) => {
      const el = scoreRef.current;

      // Full-body presence gate: never score or accrue hold-time on a partial
      // body. Until the legs are in frame we pause evaluation and prompt the
      // user; scoring resumes automatically once the full body returns.
      if (!hasFullBody(kp)) {
        if (el) {
          el.textContent =
            "Step back so we can see your whole body — legs included.";
          el.style.color = "#fbbf24";
          el.style.fontSize = "0.95rem";
        }
        holdStartRef.current = null;
        if (holdBarRef.current) holdBarRef.current.style.width = "0%";
        return;
      }

      const raw = scorePose(checkpoint.angles, angles);

      // Smooth the score over a short window (mirrors the spike).
      let smoothed: number | null = null;
      if (raw !== null) {
        const buf = scoreBufRef.current;
        buf.push(raw);
        if (buf.length > SMOOTH_WINDOW) buf.shift();
        smoothed = Math.round(buf.reduce((s, v) => s + v, 0) / buf.length);
      }

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
      // threshold continuously for HOLD_MS. A pass also requires the legs to
      // participate (≥2 shared lower-body joints), so an upper-body-only match
      // can never register as a pass.
      const now = performance.now();
      if (smoothed >= PASS_THRESHOLD && passHasLegs(checkpoint.angles, angles)) {
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

  // Show the current checkpoint's target pose as a ghost on the camera.
  // Checkpoints without stored keypoints (legacy/placeholder) → no ghost.
  useEffect(() => {
    ghostRef.current = checkpoint.keypoints ?? null;
  }, [checkpoint, ghostRef]);

  return (
    <>
      <div style={{ width: "100%", textAlign: "center" }}>
        <div style={{ fontSize: "1.35rem", fontWeight: 700 }}>{move.name}</div>
        <div style={{ color: "#888", marginTop: 2 }}>
          Pose {index + 1} of {move.checkpoints.length} ·{" "}
          <span style={{ color: "#22d3ee", fontWeight: 600 }}>
            {checkpoint.name}
          </span>
          {onRewatch && (
            <>
              {" · "}
              <button
                onClick={onRewatch}
                style={{
                  background: "none",
                  border: "none",
                  color: "#666",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                  padding: 0,
                }}
              >
                ↺ Rewatch demo
              </button>
            </>
          )}
        </div>
      </div>

      {/* The camera is the hero: live score chip + hold bar live on top of it,
          all driven via DOM refs (no per-frame React state). */}
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

      {checkpoint.keypoints && (
        <div style={{ color: "#888", fontSize: "0.8rem" }}>
          <span style={{ color: "#ff40ff" }}>⬤</span> target pose ·{" "}
          <span style={{ color: "cyan" }}>⬤</span> you — line yourself up with
          the glow
        </div>
      )}

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
  firstCompletion,
  onRetry,
  onBack,
}: {
  move: Move;
  peaks: number[];
  firstCompletion: boolean;
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

      {firstCompletion && (
        <div
          style={{
            width: "100%",
            textAlign: "center",
            padding: "14px 16px",
            borderRadius: 8,
            border: "1px solid #14532d",
            background: "linear-gradient(180deg, #0c1f13 0%, #111 100%)",
            color: "#4ade80",
            fontWeight: 700,
          }}
        >
          🎉 You’ve mastered this move!
        </div>
      )}

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

const chip = (color: string, border: string): React.CSSProperties => ({
  fontSize: "0.75rem",
  fontWeight: 600,
  color,
  border: `1px solid ${border}`,
  borderRadius: 999,
  padding: "1px 8px",
});

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
