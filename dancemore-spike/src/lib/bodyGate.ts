// Full-body integrity helpers for scoring. These live OUTSIDE pose.ts and do
// not touch the angle math, TOLERANCE, or any pass threshold — they only gate
// *when* scoring runs and *when* a pass is allowed to count, so that a still
// upper-body pose can never out-score real dancing.

import { MIN_CONF, type KP } from "./pose";

// "Full body visible" = the LEGS are in frame: both hips + both knees detected
// with confidence ≥ MIN_CONF. Deliberately lower-body only — head, face, and
// shoulders are NOT required, because at a normal dancing distance the whole
// person rarely fits and demanding the head/feet made this gate impossible to
// satisfy (the "step back" prompt would never clear). Knees+hips is enough to
// credit leg movement. Ankles are the jitteriest, most-often-cropped keypoints
// (feet cut off at desk-camera height), so they're intentionally NOT required —
// requiring them is exactly what reintroduced the "step back won't clear" bug.
// This now matches legsPresent() below, so the displayed gate and the scoring
// gate agree on what "legs in frame" means.
export function hasFullBody(keypoints: KP[]): boolean {
  const by: Record<string, KP> = {};
  for (const k of keypoints) by[k.name] = k;
  const ok = (name: string) => (by[name]?.score ?? 0) >= MIN_CONF;
  return (
    ok("left_hip") && ok("right_hip") && ok("left_knee") && ok("right_knee")
  );
}

// ── Stable full-body GATE (hysteresis + temporal debounce) ───────────────────
// hasFullBody() above is a clean per-frame predicate, but leg-keypoint
// confidence naturally wobbles around any single line (normal at distance / in
// imperfect light), so consumed raw it chatters frame-to-frame: the indicator
// flickers green↔yellow and the auto-start countdown keeps cancelling. This
// gate wraps the SAME keypoints in a sticky state machine — two thresholds so
// boundary noise can't flip it, plus a debounce so a change must persist before
// it takes effect. It feeds ONLY the displayed indicator and auto-start; the
// scoring core (scoreCheckpointFrame → hasFullBody) is deliberately left as-is.

// Enter (not-detected → detected) needs the legs CLEARLY present; exit
// (detected → not-detected) needs them CLEARLY gone. The gap between the bars is
// the hysteresis: confidence hovering in-between holds the current state put.
const GATE_ENTER_CONF = 0.35;
const GATE_EXIT_CONF = 0.2;
// A change to the gate's target must hold continuously for this long before the
// state flips, so a single noisy frame can never flip green↔yellow (~several
// frames at typical webcam rates).
const GATE_DEBOUNCE_MS = 350;

// Gate entry subset: both hips + both knees must be reliably present. Ankles are
// the jitteriest keypoints, so they're helpful-but-not-mandatory here — a
// flickering ankle alone can never drop the gate. (passHasLegs and the scoring
// gate are unaffected; this governs only the displayed/auto-start signal.)
function legsPresent(keypoints: KP[], conf: number): boolean {
  const by: Record<string, KP> = {};
  for (const k of keypoints) by[k.name] = k;
  const ok = (name: string) => (by[name]?.score ?? 0) >= conf;
  return ok("left_hip") && ok("right_hip") && ok("left_knee") && ok("right_knee");
}

export type FullBodyGate = {
  // Feed one frame's keypoints + a timestamp (ms); returns the stable, debounced
  // gate state. Call once per frame so the debounce window stays continuous.
  update(keypoints: KP[], now: number): boolean;
};

// Per-consumer gate instance: each detection loop keeps its own state, since the
// debounce is time-based and frame cadence differs between views.
export function createFullBodyGate(): FullBodyGate {
  let state = false; // committed, debounced gate state
  let pendingSince: number | null = null; // when `target` first diverged from `state`

  return {
    update(keypoints: KP[], now: number): boolean {
      // Hysteresis: once detected we only need the legs to STAY above the low
      // exit bar; while not detected we need them clearly above the high enter
      // bar before flipping on.
      const target = state
        ? legsPresent(keypoints, GATE_EXIT_CONF)
        : legsPresent(keypoints, GATE_ENTER_CONF);

      if (target === state) {
        pendingSince = null; // no pending change — reset the debounce timer
      } else if (pendingSince === null) {
        pendingSince = now; // a new candidate change — start timing it
      } else if (now - pendingSince >= GATE_DEBOUNCE_MS) {
        state = target; // sustained long enough — commit the flip
        pendingSince = null;
      }
      return state;
    },
  };
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
