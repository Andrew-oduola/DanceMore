// Shared green/amber/red coloring for a 0..100 score, matching the spike.
export function scoreColor(n: number): string {
  return n >= 80 ? "#22c55e" : n >= 50 ? "#f59e0b" : "#ef4444";
}
