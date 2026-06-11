// The per-frame scoring core, shared verbatim by self-paced and synced
// practice. It does NOT touch pose.ts — it calls scorePose/angleVector exactly
// as before, applies the full-body gate and the leg requirement, and runs the
// pass-through window. Both modes use this so scoring is never re-implemented;
// they differ only in WHICH checkpoint is active and the layout around it.

import { scorePose, type KP } from "./pose";
import { hasFullBody, passHasLegs } from "./bodyGate";

// ── Pass / smoothing dials (unchanged values) ───────────────────────────────
export const PASS_THRESHOLD = 70;
export const PASS_WINDOW_MS = 180; // a few frames at/above threshold = a pass-through hit
export const PASS_SMOOTH_WINDOW = 3; // light smoothing for pass detection
export const SMOOTH_WINDOW = 10; // smoothing for the displayed number + best score

export type FrameOutcome = {
  // "no-body": legs not in frame (prompt). "get-into-frame": <4 shared joints.
  // "scoring": a number is available.
  state: "no-body" | "get-into-frame" | "scoring";
  smoothed: number | null; // display/best score
  passProgress: number; // 0..1 toward a pass (for the progress bar)
  passed: boolean; // the pass-through window completed on this frame
  passStart: number | null; // updated window-start; caller stores it back
};

// Score one webcam frame against a single target checkpoint. Mutates `scoreBuf`
// in place; returns the updated `passStart` (caller persists it).
export function scoreCheckpointFrame(
  kp: KP[],
  angles: Record<number, number>,
  targetAngles: Record<number, number>,
  scoreBuf: number[],
  passStart: number | null,
  now: number
): FrameOutcome {
  // Full-body presence gate — never score/accrue on a partial body.
  if (!hasFullBody(kp)) {
    return { state: "no-body", smoothed: null, passProgress: 0, passed: false, passStart: null };
  }

  const raw = scorePose(targetAngles, angles);

  let smoothed: number | null = null;
  let passScore: number | null = null;
  if (raw !== null) {
    scoreBuf.push(raw);
    if (scoreBuf.length > SMOOTH_WINDOW) scoreBuf.shift();
    smoothed = Math.round(scoreBuf.reduce((s, v) => s + v, 0) / scoreBuf.length);
    const k = Math.min(PASS_SMOOTH_WINDOW, scoreBuf.length);
    const recent = scoreBuf.slice(scoreBuf.length - k);
    passScore = Math.round(recent.reduce((s, v) => s + v, 0) / k);
  }

  if (smoothed === null) {
    return { state: "get-into-frame", smoothed: null, passProgress: 0, passed: false, passStart: null };
  }

  // Pass-through: score must stay >= threshold across a short window, and the
  // legs must participate (>=2 shared lower-body joints).
  let passed = false;
  let passProgress = 0;
  let nextPassStart = passStart;
  if (
    passScore !== null &&
    passScore >= PASS_THRESHOLD &&
    passHasLegs(targetAngles, angles)
  ) {
    if (nextPassStart === null) nextPassStart = now;
    const inWindow = now - nextPassStart;
    passProgress = Math.min(1, inWindow / PASS_WINDOW_MS);
    if (inWindow >= PASS_WINDOW_MS) passed = true;
  } else {
    nextPassStart = null;
  }

  return { state: "scoring", smoothed, passProgress, passed, passStart: nextPassStart };
}

// ── Synced mode: which checkpoint is active at a given video time ────────────
// Each checkpoint i gets a scoring window around its timestamp t_i. Windows are
// kept NON-OVERLAPPING by capping the end at the next checkpoint's window start
// (t_{i+1} − PRE), so at most one checkpoint is ever active:
//   window_i = [ t_i − PRE , min(t_i + POST, t_{i+1} − PRE) )
export const WINDOW_PRE = 0.4; // seconds before t you may start hitting the pose
export const WINDOW_POST = 0.8; // seconds after t you may still land it

// `sortedTs` must be ascending. Returns the active index into that sorted
// array, or -1 when vt is before the first / in a gap / after the last window.
export function activeCheckpoint(sortedTs: number[], vt: number): number {
  for (let i = 0; i < sortedTs.length; i++) {
    const start = sortedTs[i] - WINDOW_PRE;
    const cap =
      i + 1 < sortedTs.length ? sortedTs[i + 1] - WINDOW_PRE : Infinity;
    const end = Math.min(sortedTs[i] + WINDOW_POST, cap);
    if (vt >= start && vt < end) return i;
  }
  return -1;
}
