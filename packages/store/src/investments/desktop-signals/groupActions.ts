/** Source group fan-out is deliberately sequential. A later refusal cannot erase earlier saves. */
export type GroupSaveOutcome =
  | { readonly status: "saved"; readonly decisions: readonly string[] }
  | { readonly status: "skipped"; readonly decisions: readonly [] }
  | { readonly status: "partial"; readonly decisions: readonly string[]; readonly reason: string }
  | { readonly status: "unknown"; readonly decisions: readonly string[] }
  | { readonly status: "refused"; readonly decisions: readonly []; readonly reason: string };

export async function saveSignalGroup(
  steps: readonly (() => Promise<
    | { readonly ok: true; readonly value: { readonly decision: string | null } }
    | { readonly ok: false; readonly reason: string }
  >)[],
  isCurrent: () => boolean = () => true,
): Promise<GroupSaveOutcome> {
  const decisions: string[] = [];
  for (const step of steps) {
    if (!isCurrent())
      return decisions.length
        ? { status: "partial", decisions, reason: "scope_changed" }
        : { status: "refused", decisions: [], reason: "scope_changed" };
    let result: Awaited<ReturnType<typeof step>>;
    try {
      result = await step();
    } catch {
      return { status: "unknown", decisions };
    }
    if (!result.ok)
      return decisions.length
        ? { status: "partial", decisions, reason: result.reason }
        : { status: "refused", decisions: [], reason: result.reason };
    if (result.value.decision !== null) decisions.push(result.value.decision);
  }
  return decisions.length ? { status: "saved", decisions } : { status: "skipped", decisions: [] };
}
