// Frame-interval summary, the S50 method unchanged (~/cashu-lab/checkpoints/S50.md) so the numbers of
// the real app compare with the spike's.
export interface FrameReport {
  frames: number;
  durationMs: number;
  fps: number;
  dropped: number;
  droppedPct: number;
  worstMs: number;
  p95Ms: number;
}

export function summarize(intervals: readonly number[], budgetMs = 1000 / 60): FrameReport {
  const sorted = [...intervals].sort((a, b) => a - b);
  const total = intervals.reduce((s, x) => s + x, 0);
  const dropped = intervals.reduce((s, x) => s + Math.max(0, Math.round(x / budgetMs) - 1), 0);
  const expected = Math.round(total / budgetMs) || 1;
  return {
    frames: intervals.length,
    durationMs: Math.round(total),
    fps: total > 0 ? Math.round((intervals.length / total) * 1000 * 10) / 10 : 0,
    dropped,
    droppedPct: Math.round((dropped / expected) * 1000) / 10,
    worstMs: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
    p95Ms: Math.round((sorted[Math.floor(sorted.length * 0.95)] ?? 0) * 10) / 10,
  };
}
