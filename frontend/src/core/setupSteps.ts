// Pure helpers over a module's setup steps (GET /modules/{id}/setup): counts and the next step skip the
// optional ones (design/v3/first-steps D8: an optional step never counts toward the module state). Tested in
// tests/first-steps.test.mjs.

export interface StepLike { id?: string; title: string; status: "done" | "on" | "todo"; optional?: boolean }

/** Done and total of the required steps. */
export function stepCounts(steps: readonly StepLike[] | null | undefined): { done: number; n: number } {
  const req = (steps ?? []).filter((s) => !s.optional);
  return { done: req.filter((s) => s.status === "done").length, n: req.length };
}

/** The step to continue with: the required one that is on, else the first required one not done. */
export function nextStep<T extends StepLike>(steps: readonly T[] | null | undefined): T | null {
  const req = (steps ?? []).filter((s) => !s.optional);
  return req.find((s) => s.status === "on") ?? req.find((s) => s.status !== "done") ?? null;
}

/** "Kategorie wydatków" -> "kategorie wydatków" (inside a sentence). */
export const lowerFirst = (t: string): string => t.charAt(0).toLowerCase() + t.slice(1);

/** "{Moduł} · 2 z 3 kroków · następny: …" of the partial-setup strip (without the module name). */
export function partialLine(steps: readonly StepLike[] | null | undefined): string {
  const { done, n } = stepCounts(steps);
  const next = nextStep(steps);
  return `${done} z ${n} ${n === 1 ? "kroku" : "kroków"}${next ? ` · następny: ${lowerFirst(next.title)}` : ""}`;
}

/** The step of `id`, else of the first of `fallbacks` the server still sends (an older server's step ids). */
export function stepById<T extends { id: string }>(steps: readonly T[] | null | undefined, id: string, ...fallbacks: string[]): T | null {
  for (const k of [id, ...fallbacks]) {
    const s = (steps ?? []).find((x) => x.id === k);
    if (s) return s;
  }
  return null;
}
