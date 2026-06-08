// Offline pose extraction from an uploaded video element. Samples frames,
// runs MoveNet on each, and returns candidates (angles + skeleton thumbnail)
// that the user curates into a Move's checkpoints.

import * as poseDetection from "@tensorflow-models/pose-detection";
import { angleVector, type KP } from "./pose";

const MIN_CONF = 0.3;
const THUMB_W = 240;
// scorePose needs ≥4 shared joints to return a number; below this the frame
// is "low confidence" — still usable, just less reliable for scoring.
const MIN_RELIABLE_JOINTS = 4;

export type Candidate = {
  id: number;
  time: number; // seconds into the clip
  angles: Record<number, number>;
  keypoints: KP[]; // raw MoveNet keypoints — stored on the checkpoint for the ghost overlay
  lowConfidence: boolean; // fewer than MIN_RELIABLE_JOINTS confident joints
  thumb: string; // JPEG data-URL of the frame with the skeleton drawn on it
};

let nextId = 1;

// Seek and wait until the target frame is actually painted. Setting
// currentTime alone is NOT enough — `seeked` fires when the seek completes,
// and one rAF ensures the frame has been composited before estimatePoses
// reads the element.
export async function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = t;
  });
  await new Promise(requestAnimationFrame);
}

// Estimate the pose on the video's CURRENT frame and ALWAYS return a candidate
// when a pose is read — flagging `lowConfidence` when fewer than the reliable
// number of joints are confident, rather than refusing the frame. Each stored
// keypoint keeps its real confidence score, so downstream consumers
// (angleVector for scoring, the ghost overlay) already skip the weak joints —
// nothing bogus is stored as if it were solid. Returns null only when the
// detector itself fails or yields no pose object at all.
export async function captureFrame(
  video: HTMLVideoElement,
  detector: poseDetection.PoseDetector
): Promise<Candidate | null> {
  await new Promise(requestAnimationFrame); // make sure the frame is painted
  let poses: poseDetection.Pose[];
  try {
    poses = await detector.estimatePoses(video, { flipHorizontal: false });
  } catch {
    return null;
  }
  if (!poses[0]) return null;
  const keypoints: KP[] = poses[0].keypoints.map((k) => ({
    x: k.x,
    y: k.y,
    score: k.score ?? 0,
    name: k.name ?? "",
  }));
  const angles = angleVector(keypoints);
  return {
    id: nextId++,
    time: video.currentTime,
    angles,
    keypoints,
    lowConfidence: Object.keys(angles).length < MIN_RELIABLE_JOINTS,
    thumb: drawThumb(video, keypoints),
  };
}

// Sample `count` evenly-spaced timestamps across the clip and keep only the
// frames where a pose was CONFIDENTLY detected. (Manual "Capture this frame"
// is allowed to keep low-confidence frames; auto-sampling stays selective.)
export async function extractCandidates(
  video: HTMLVideoElement,
  detector: poseDetection.PoseDetector,
  count = 10,
  onProgress?: (pct: number) => void
): Promise<Candidate[]> {
  const duration = video.duration;
  if (!isFinite(duration) || duration <= 0) return [];
  const out: Candidate[] = [];
  for (let i = 0; i < count; i++) {
    const t = (duration * (i + 0.5)) / count;
    await seekTo(video, t);
    const c = await captureFrame(video, detector);
    if (c && !c.lowConfidence) out.push(c);
    onProgress?.(Math.round(((i + 1) / count) * 100));
  }
  return out;
}

// "Dancer faces me (mirror)": map the dancer's left joints onto the user's
// right and vice versa. pose.ts orders JOINTS as left/right pairs, so each
// pair is (even, even+1) and the mirror partner of index i is i^1.
export function mirrorAngles(
  angles: Record<number, number>
): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(angles)) out[Number(k) ^ 1] = v;
  return out;
}

// Mirror the raw keypoints the same way: flip x about the figure's own
// horizontal center AND swap left_/right_ names, producing a true mirrored
// person. Invariant: angleVector(mirrorKeypoints(k)) === mirrorAngles(
// angleVector(k)), so the ghost overlay and scoring can never disagree.
export function mirrorKeypoints(keypoints: KP[]): KP[] {
  const confident = keypoints.filter((k) => k.score >= MIN_CONF);
  const xs = (confident.length ? confident : keypoints).map((k) => k.x);
  const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
  return keypoints.map((k) => ({
    ...k,
    x: 2 * mid - k.x,
    name: k.name.startsWith("left_")
      ? k.name.replace("left_", "right_")
      : k.name.startsWith("right_")
        ? k.name.replace("right_", "left_")
        : k.name,
  }));
}

function drawThumb(video: HTMLVideoElement, keypoints: KP[]): string {
  const scale = THUMB_W / video.videoWidth;
  const w = THUMB_W;
  const h = Math.round(video.videoHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(video, 0, 0, w, h);

  const adjacentPairs = poseDetection.util.getAdjacentPairs(
    poseDetection.SupportedModels.MoveNet
  );
  ctx.strokeStyle = "cyan";
  ctx.lineWidth = 2;
  for (const [i, j] of adjacentPairs) {
    const a = keypoints[i];
    const b = keypoints[j];
    if (a && b && a.score >= MIN_CONF && b.score >= MIN_CONF) {
      ctx.beginPath();
      ctx.moveTo(a.x * scale, a.y * scale);
      ctx.lineTo(b.x * scale, b.y * scale);
      ctx.stroke();
    }
  }
  ctx.fillStyle = "white";
  for (const kp of keypoints) {
    if (kp.score >= MIN_CONF) {
      ctx.beginPath();
      ctx.arc(kp.x * scale, kp.y * scale, 2.5, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  return canvas.toDataURL("image/jpeg", 0.7);
}
