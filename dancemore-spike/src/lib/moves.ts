// A Move is an ordered list of checkpoint poses. Each checkpoint stores a
// reference angle-vector — the exact structure scorePose() already consumes.

import type { KP } from "./pose";

export type Checkpoint = {
  name: string; // e.g. "Arms up"
  angles: Record<number, number>; // jointIndex -> angle, same shape angleVector returns
  // Raw MoveNet keypoints from the captured frame — lets PRACTICE draw the
  // target pose as a ghost skeleton. Optional: legacy checkpoints without it
  // simply show no ghost. Scoring uses `angles` only, never this.
  keypoints?: KP[];
};

export type Move = {
  id: string;
  name: string; // e.g. "Side Step Reach"
  description?: string; // one line shown on the watch screen
  demoVideo?: string; // path under /public/videos, e.g. "/videos/side-step.mp4"
  checkpoints: Checkpoint[]; // 2–3 per move
};

// Loads the move library shipped in public/moves.json.
export async function loadMoves(): Promise<Move[]> {
  const res = await fetch("/moves.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load moves.json (${res.status})`);
  return (await res.json()) as Move[];
}
