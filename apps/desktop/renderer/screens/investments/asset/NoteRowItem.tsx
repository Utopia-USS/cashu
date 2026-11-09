// One research note row (old research primitives NoteRow) from its model (assetResearchModel.ts noteRowModel):
// the asset detail's Research widget and the topic drawer's Notatki share it. Pure.
import { NoteRow, Tag } from "@cashu/ui";
import type { NoteRowModel } from "./assetResearchModel.js";

export function NoteRowItem({
  n,
  onToggle,
  onRestore,
  onDismiss,
}: {
  n: NoteRowModel;
  onToggle(): void;
  onRestore(): unknown;
  onDismiss(): unknown;
}) {
  return (
    <NoteRow
      id={n.id}
      title={n.title}
      tip={n.tip}
      relation={n.relation}
      badge={n.badge ? <Tag className="mt-px">{n.badge}</Tag> : undefined}
      open={n.open}
      dim={n.dim}
      highlight={n.highlight}
      sources={n.sources}
      summary={
        n.summary
          ? n.summary.map((part) => (part.bold ? <b key={part.key}>{part.text}</b> : part.text))
          : undefined
      }
      onToggle={onToggle}
      restore={n.restore ? { ...n.restore, onRestore } : undefined}
      dismiss={n.dismiss ? { ...n.dismiss, onDismiss } : undefined}
    />
  );
}
