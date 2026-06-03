// A Move is an ordered list of checkpoint poses. Each checkpoint stores a
// reference angle-vector — the exact structure scorePose() already consumes.

export type Checkpoint = {
  name: string; // e.g. "Arms up"
  angles: Record<number, number>; // jointIndex -> angle, same shape angleVector returns
};

export type Move = {
  id: string;
  name: string; // e.g. "Side Step Reach"
  checkpoints: Checkpoint[]; // 2–3 per move
};

// Loads the move library shipped in public/moves.json.
export async function loadMoves(): Promise<Move[]> {
  const res = await fetch("/moves.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load moves.json (${res.status})`);
  return (await res.json()) as Move[];
}
