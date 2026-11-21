import { isRecord } from "@cashu/domain";
/** Generated domain payload fields may contain older arbitrary JSON prose. */
export function reviewBriefs(rows: readonly unknown[]) {
  return rows.flatMap((row) =>
    isRecord(row) && typeof row.note_id === "string"
      ? [
          {
            note: row.note_id,
            headline: typeof row.headline === "string" ? row.headline : null,
            why: typeof row.why === "string" ? row.why : null,
          },
        ]
      : [],
  );
}
export function reviewMacroChanges(rows: readonly unknown[]) {
  return rows.flatMap((row) =>
    isRecord(row) &&
    typeof row.key === "string" &&
    typeof row.label === "string" &&
    typeof row.from_label === "string" &&
    typeof row.to_label === "string"
      ? [
          {
            key: row.key,
            label: row.label,
            from: row.from_label,
            to: row.to_label,
            since: typeof row.since === "string" ? row.since : null,
          },
        ]
      : [],
  );
}
export interface ReviewSectorRow {
  readonly key: string;
  readonly label: string;
  readonly contribution: number;
  readonly weight: number | null;
  readonly ret: number | null;
  readonly currency: boolean;
  readonly briefs: ReturnType<typeof reviewBriefs>;
}
