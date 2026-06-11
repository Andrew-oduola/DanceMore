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
  // Seconds into the demo video where this pose occurs. Optional — only set
  // for synced (dance-along) moves; absent ⇒ the move runs self-paced.
  t?: number;
};

export type Move = {
  id: string;
  name: string; // e.g. "Side Step Reach"
  description?: string; // one line shown on the watch screen
  demoVideo?: string; // path under /public/videos, e.g. "/videos/side-step.mp4"
  // YouTube video ID for the WATCH step (privacy-enhanced no-cookie embed).
  // Watch-only — never analyzed or scored (cross-origin iframe). Takes
  // precedence over demoVideo. "REPLACE_ME" is treated as unset.
  youtubeId?: string;
  // Global nudge (seconds) to align checkpoint `t` values to the YouTube
  // timeline when the cut starts slightly before/after the checkpoint source.
  videoOffset?: number;
  checkpoints: Checkpoint[]; // 2–3 per move
};

// A move runs in synced (dance-along) mode only when it has BOTH a usable
// YouTube video AND at least one timestamped checkpoint. Otherwise it falls
// through to the existing self-paced practice, unchanged.
export function isSynced(move: Move): boolean {
  return (
    validYoutubeId(move) !== undefined &&
    move.checkpoints.some((c) => typeof c.t === "number")
  );
}

// A youtubeId that's actually usable (placeholder values don't count).
// Accepts a bare video ID or a pasted URL in any common shape —
// youtu.be/<id>, watch?v=<id>, shorts/<id>, embed/<id> — and returns the
// bare ID the nocookie embed needs.
export function validYoutubeId(move: Move): string | undefined {
  const raw = move.youtubeId?.trim();
  if (!raw || raw === "REPLACE_ME") return undefined;
  const fromUrl = raw.match(
    /(?:youtu\.be\/|[?&]v=|shorts\/|embed\/)([A-Za-z0-9_-]{6,})/
  );
  if (fromUrl) return fromUrl[1];
  return /^[A-Za-z0-9_-]{6,}$/.test(raw) ? raw : undefined;
}

// Loads the move library shipped in public/moves.json.
export async function loadMoves(): Promise<Move[]> {
  const res = await fetch("/moves.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load moves.json (${res.status})`);
  return (await res.json()) as Move[];
}
