export type KP = { x: number; y: number; score: number; name: string };

// Angle (degrees) at vertex B formed by points A-B-C
function angleABC(A: KP, B: KP, C: KP): number {
  const ab = { x: A.x - B.x, y: A.y - B.y };
  const cb = { x: C.x - B.x, y: C.y - B.y };
  const dot = ab.x * cb.x + ab.y * cb.y;
  const mag = Math.hypot(ab.x, ab.y) * Math.hypot(cb.x, cb.y) + 1e-9;
  const cos = Math.min(1, Math.max(-1, dot / mag));
  return (Math.acos(cos) * 180) / Math.PI;
}

// The 8 joints we score, each defined by three MoveNet keypoint names
const JOINTS: [string, string, string][] = [
  ["left_shoulder", "left_elbow", "left_wrist"], // left elbow
  ["right_shoulder", "right_elbow", "right_wrist"], // right elbow
  ["left_elbow", "left_shoulder", "left_hip"], // left shoulder
  ["right_elbow", "right_shoulder", "right_hip"], // right shoulder
  ["left_shoulder", "left_hip", "left_knee"], // left hip
  ["right_shoulder", "right_hip", "right_knee"], // right hip
  ["left_hip", "left_knee", "left_ankle"], // left knee
  ["right_hip", "right_knee", "right_ankle"], // right knee
];

const MIN_CONF = 0.3;

// Returns a map of jointIndex -> angle, skipping low-confidence joints
export function angleVector(keypoints: KP[]): Record<number, number> {
  const byName: Record<string, KP> = {};
  for (const kp of keypoints) byName[kp.name] = kp;
  const out: Record<number, number> = {};
  JOINTS.forEach(([a, b, c], i) => {
    const A = byName[a],
      B = byName[b],
      C = byName[c];
    if (
      A &&
      B &&
      C &&
      A.score >= MIN_CONF &&
      B.score >= MIN_CONF &&
      C.score >= MIN_CONF
    ) {
      out[i] = angleABC(A, B, C);
    }
  });
  return out;
}

// 0..100. Only compares joints present in BOTH vectors.
const TOLERANCE = 50; // avg angle error (deg) that maps to a score of 0 — tune this
export function scorePose(
  ref: Record<number, number>,
  live: Record<number, number>
): number | null {
  const shared = Object.keys(ref)
    .map(Number)
    .filter((i) => i in live);
  if (shared.length < 4) return null; // not enough visible joints to judge
  const meanDiff =
    shared.reduce((s, i) => s + Math.abs(ref[i] - live[i]), 0) / shared.length;
  return Math.max(
    0,
    Math.min(100, Math.round(100 * (1 - meanDiff / TOLERANCE)))
  );
}
