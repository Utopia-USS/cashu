import { FRESH_LABEL, freshOf, hintChip, planLabel } from "@cashu/ui-logic/investments/v2/logic";

export function investmentMarks(
  instrument: {
    readonly plan?: string | null;
    readonly plan_freshness?: { readonly state: "fresh" | "maybe_outdated" | "outdated" } | null;
  },
  hints: readonly { readonly code: string; readonly params: Readonly<Record<string, unknown>> }[],
  held: boolean,
): string[] {
  const fresh = freshOf(instrument.plan_freshness);
  return [
    ...new Set(
      [
        planLabel(instrument.plan, held),
        fresh === null ? "" : FRESH_LABEL[fresh],
        ...hints.map((hint) => hintChip(hint, held)),
      ].filter(Boolean),
    ),
  ];
}
