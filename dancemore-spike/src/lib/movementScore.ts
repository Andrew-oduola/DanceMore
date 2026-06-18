// Movement-mode scoring — a SEPARATE path from checkpoint/synced scoring.
//
// Instead of matching the user to a target pose (scoreCheckpointFrame in
// practiceScore.ts, which this file never touches), this scores the user's OWN
// movement: how much they move and how much of their WHOLE body they engage.
// The video is pure background, so any clip works and nothing has to "match".
//
// Everything is measured in TORSO-LENGTHS PER SECOND, which makes the score:
//   • distance-invariant — normalized by the user's torso length, so standing
//     closer/farther from the camera doesn't change it; and
//   • frame-rate-invariant — divided by the real elapsed time per frame.
// Smoothing (per-region EMA) + a noise floor + body-scale normalization keep
// camera jitter from inflating the score; coverage weighting + a per-region cap
// keep one fast-waving limb from dominating; leg weight makes engaging the legs
// visibly raise the score over upper-body-only movement.

import { hasFullBody } from "./bodyGate";
import { MIN_CONF, type KP } from "./pose";

export type Region = "head" | "arms" | "torso" | "legs";
export const REGIONS: Region[] = ["head", "arms", "torso", "legs"];
export const REGION_LABEL: Record<Region, string> = {
  head: "Head",
  arms: "Arms",
  torso: "Torso",
  legs: "Legs",
};

// Which MoveNet keypoints make up each region. Shoulders are shared by
// arms+torso and hips by torso+legs — moving them genuinely engages both, so
// the overlap is intentional, not a bug.
const REGION_KP: Record<Region, string[]> = {
  head: ["nose", "left_eye", "right_eye", "left_ear", "right_ear"],
  arms: [
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
  ],
  torso: ["left_shoulder", "right_shoulder", "left_hip", "right_hip"],
  legs: [
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
  ],
};

// Region weights into the frame score. Legs are weighted highest — the client's
// explicit ask: engaging the legs must visibly out-score upper-body-only.
const REGION_WEIGHT: Record<Region, number> = {
  head: 0.6,
  arms: 1.0,
  torso: 1.0,
  legs: 1.4,
};
const MAX_WEIGHT = REGIONS.reduce((s, r) => s + REGION_WEIGHT[r], 0); // 4.0

// ── Tuning dials (all in torso-lengths / second unless noted) ────────────────
// We low-pass each keypoint's POSITION first (vector EMA): opposing jitter
// vectors average toward the true point, so high-frequency camera/keypoint
// noise barely moves the smoothed position while real motion passes through.
// Velocity is then measured from the smoothed track — this is what keeps a
// perfectly still (but noisy) subject from accruing any score.
const POS_ALPHA = 0.35; // position smoothing — lower = more jitter rejection, more lag
const VEL_ALPHA = 0.5; // light extra smoothing on the per-region velocity (meter stability)
const NOISE_FLOOR = 0.35; // below this (torso-lengths/sec) = residual jitter → no movement
const ACTIVE_VEL = 0.5; // a region is "active" once its smoothed velocity clears this
const REF_VEL = 2.0; // smoothed velocity that counts as full (1.0) regional intensity
const MIN_DT = 1 / 90; // clamp the per-frame timestep so a stutter can't spike velocity
const MAX_DT = 1 / 12;
const RESET_GAP_MS = 400; // a gap longer than this → treat the next frame as a fresh start
// Overall gain so sustained whole-body dancing lands in a satisfying range
// while standing still stays at 0 (gain * 0 = 0). Purely a display mapping.
const SCORE_GAIN = 1.6;

export type RegionLive = { intensity: number; active: boolean };

export type MovementFrame = {
  // "no-body": legs not in frame (reuses the shared full-body gate).
  // "get-ready": first frame / scale not yet measurable — nothing scored yet.
  // "scoring": a live number is accruing.
  state: "no-body" | "get-ready" | "scoring";
  intensity: number; // 0..1 smoothed current movement, for the live meter
  regions: Record<Region, RegionLive>; // live per-region intensity + active flag
  score: number; // 0..100 running session score
};

export type MovementResult = {
  overall: number; // 0..100
  regions: Record<Region, number>; // 0..100 engagement per region
};

// Hip-center↔shoulder-center distance in pixels — the body scale we normalize
// every displacement by. Needs confident shoulders + hips; null otherwise.
function torsoLength(by: Record<string, KP>): number | null {
  const ls = by["left_shoulder"];
  const rs = by["right_shoulder"];
  const lh = by["left_hip"];
  const rh = by["right_hip"];
  if (
    !ls ||
    !rs ||
    !lh ||
    !rh ||
    ls.score < MIN_CONF ||
    rs.score < MIN_CONF ||
    lh.score < MIN_CONF ||
    rh.score < MIN_CONF
  )
    return null;
  const sx = (ls.x + rs.x) / 2;
  const sy = (ls.y + rs.y) / 2;
  const hx = (lh.x + rh.x) / 2;
  const hy = (lh.y + rh.y) / 2;
  const len = Math.hypot(sx - hx, sy - hy);
  return len > 1 ? len : null;
}

function zeroRegions<T>(make: () => T): Record<Region, T> {
  return { head: make(), arms: make(), torso: make(), legs: make() };
}

// A stateful per-session scorer. One instance per practice run; call frame()
// once per webcam frame while running, then result() at the end.
export type MovementScorer = {
  frame(kp: KP[], now: number): MovementFrame;
  result(): MovementResult;
  reset(): void;
};

export function createMovementScorer(): MovementScorer {
  // Smoothed (low-pass) keypoint positions — what we measure velocity from.
  let smooth: Record<string, { x: number; y: number }> | null = null;
  let prevTime: number | null = null;
  const ema = zeroRegions(() => 0); // smoothed per-region velocity
  let displayIntensity = 0; // smoothed meter value

  // Session accumulators: mean frame-score → overall; mean per-region intensity
  // → the breakdown bars.
  let sumFrame = 0;
  let nFrames = 0;
  const sumRegionU = zeroRegions(() => 0);

  function idle(state: "no-body" | "get-ready"): MovementFrame {
    return {
      state,
      intensity: displayIntensity,
      regions: zeroRegions<RegionLive>(() => ({ intensity: 0, active: false })),
      score: nFrames > 0 ? Math.round(sumFrame / nFrames) : 0,
    };
  }

  return {
    reset() {
      smooth = null;
      prevTime = null;
      for (const r of REGIONS) {
        ema[r] = 0;
        sumRegionU[r] = 0;
      }
      displayIntensity = 0;
      sumFrame = 0;
      nFrames = 0;
    },

    frame(kp: KP[], now: number): MovementFrame {
      // Same full-body gate the checkpoint path uses — never credit movement
      // (especially leg movement) unless the legs are actually in frame.
      if (!hasFullBody(kp)) {
        smooth = null;
        prevTime = null;
        for (const r of REGIONS) ema[r] = 0;
        displayIntensity = 0;
        return idle("no-body");
      }

      const by: Record<string, KP> = {};
      for (const k of kp) by[k.name] = k;
      const torso = torsoLength(by);
      if (torso === null) {
        // Body in frame but scale not measurable this frame — hold, don't score.
        smooth = null;
        prevTime = null;
        return idle("get-ready");
      }

      // First frame after a (re)start, or after a long gap: anchor the smoothed
      // track to the raw positions and wait — there's no prior track to diff,
      // and a stale one would teleport-spike.
      const gapped =
        prevTime === null || smooth === null || now - prevTime > RESET_GAP_MS;
      if (gapped) {
        smooth = {};
        for (const k of kp)
          if (k.score >= MIN_CONF) smooth[k.name] = { x: k.x, y: k.y };
        prevTime = now;
        return idle("get-ready");
      }

      // gapped===false above guarantees prevTime/smooth are set.
      const dt = Math.min(MAX_DT, Math.max(MIN_DT, (now - prevTime!) / 1000));
      const prevSmooth = smooth!;

      // Advance each keypoint's smoothed position one EMA step; the per-keypoint
      // velocity is the distance the SMOOTHED point travelled (jitter, having
      // averaged out, contributes almost none of it).
      const nextSmooth: Record<string, { x: number; y: number }> = {};
      const kpVel: Record<string, number> = {};
      for (const k of kp) {
        if (k.score < MIN_CONF) continue;
        const prev = prevSmooth[k.name];
        if (!prev) {
          nextSmooth[k.name] = { x: k.x, y: k.y }; // newly visible — anchor, no velocity
          continue;
        }
        const sx = prev.x + POS_ALPHA * (k.x - prev.x);
        const sy = prev.y + POS_ALPHA * (k.y - prev.y);
        nextSmooth[k.name] = { x: sx, y: sy };
        kpVel[k.name] = Math.hypot(sx - prev.x, sy - prev.y) / torso / dt;
      }

      // Per-region smoothed velocity → effective (deadzoned) → intensity u∈[0,1].
      const live = zeroRegions<RegionLive>(() => ({
        intensity: 0,
        active: false,
      }));
      let weightedSum = 0;
      let activeCount = 0;

      for (const r of REGIONS) {
        let sum = 0;
        let n = 0;
        for (const name of REGION_KP[r]) {
          if (name in kpVel) {
            sum += kpVel[name];
            n++;
          }
        }
        const rawVel = n > 0 ? sum / n : 0;
        ema[r] = ema[r] * (1 - VEL_ALPHA) + rawVel * VEL_ALPHA;

        const effective = Math.max(0, ema[r] - NOISE_FLOOR);
        const u = Math.min(1, effective / (REF_VEL - NOISE_FLOOR));
        const active = ema[r] >= ACTIVE_VEL;

        live[r] = { intensity: u, active };
        weightedSum += REGION_WEIGHT[r] * u;
        if (active) activeCount++;
        sumRegionU[r] += u;
      }

      // Frame score rewards magnitude AND coverage: the weighted-magnitude ratio
      // is scaled up by how many regions are active, so distributed whole-body
      // movement scores far higher than one flailing (capped) limb.
      const coverage = 0.4 + 0.6 * (activeCount / REGIONS.length);
      const frame01 = (weightedSum / MAX_WEIGHT) * coverage;

      sumFrame += frame01;
      nFrames++;
      displayIntensity =
        displayIntensity * (1 - VEL_ALPHA) + frame01 * VEL_ALPHA;

      smooth = nextSmooth;
      prevTime = now;

      const score = Math.round(
        Math.min(100, 100 * SCORE_GAIN * (sumFrame / nFrames))
      );
      return { state: "scoring", intensity: displayIntensity, regions: live, score };
    },

    result(): MovementResult {
      const overall =
        nFrames > 0
          ? Math.round(Math.min(100, 100 * SCORE_GAIN * (sumFrame / nFrames)))
          : 0;
      const regions = zeroRegions(() => 0);
      for (const r of REGIONS)
        regions[r] =
          nFrames > 0
            ? Math.round(Math.min(100, 100 * SCORE_GAIN * (sumRegionU[r] / nFrames)))
            : 0;
      return { overall, regions };
    },
  };
}
