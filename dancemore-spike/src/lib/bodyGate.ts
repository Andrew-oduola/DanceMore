// Full-body integrity helpers for scoring. These live OUTSIDE pose.ts and do
// not touch the angle math, TOLERANCE, or any pass threshold — they only gate
// *when* scoring runs and *when* a pass is allowed to count, so that a still
// upper-body pose can never out-score real dancing.

import { MIN_CONF, type KP } from "./pose";

// "Full body visible" = both hips + both knees + at least one ankle detected
// with confidence ≥ MIN_CONF. Strict enough to guarantee the legs are in
// frame; the single-ankle allowance keeps it from flickering when one foot is
// briefly occluded.
export function hasFullBody(keypoints: KP[]): boolean {
  const by: Record<string, KP> = {};
  for (const k of keypoints) by[k.name] = k;
  const ok = (name: string) => (by[name]?.score ?? 0) >= MIN_CONF;
  return (
    ok("left_hip") &&
    ok("right_hip") &&
    ok("left_knee") &&
    ok("right_knee") &&
    (ok("left_ankle") || ok("right_ankle"))
  );
}

// Lower-body joint indices in pose.ts JOINTS order:
//   4 = left hip, 5 = right hip, 6 = left knee, 7 = right knee.
const LOWER_BODY_JOINTS = [4, 5, 6, 7];
const MIN_LOWER_BODY_FOR_PASS = 2;

// A checkpoint pass only counts when the target and live poses share at least
// MIN_LOWER_BODY_FOR_PASS lower-body joints — so an upper-body-only match can
// never register as a pass. Operates on the same shared-joint set scorePose
// compares; it never changes the score itself.
export function passHasLegs(
  ref: Record<number, number>,
  live: Record<number, number>
): boolean {
  let shared = 0;
  for (const i of LOWER_BODY_JOINTS) if (i in ref && i in live) shared++;
  return shared >= MIN_LOWER_BODY_FOR_PASS;
}
