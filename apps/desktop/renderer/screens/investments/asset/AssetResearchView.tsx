// The Research widget of the asset detail (ab24ab6 v2/research/AssetResearch.tsx AssetResearch): the never-ran
// state, else the run tag or `n notatek · date`, the older-notes toggle, the 8-week sentiment summary row and one
// NoteRow per note. Pure: assetResearchModel.ts carries the texts.
import { NoteRow, SentimentBars, Tag, Widget } from "@cashu/ui";
import type { AssetResearchModel } from "./assetResearchModel.js";

export interface AssetResearchUi {
  onToggleOlder(): void;
  onToggleNote(id: number): void;
  onDismiss(id: number): void;
  onRestore(id: number): void;
}

const tagTone = { "": "neutral", warn: "warning", info: "info", neg: "negative" } as const;
const valueTone = { pos: "text-positive", neg: "text-negative", "": "" } as const;

export function AssetResearchView({
  model: r,
  ui,
}: {
  model: AssetResearchModel;
  ui: AssetResearchUi;
}) {
  if (!r.ran)
    return (
      <Widget title={r.title} id="asset-research" tight tags={<Tag>{r.tag}</Tag>}>
        <div className="text-sm text-fg-muted">{r.empty}</div>
      </Widget>
    );
  return (
    <Widget
      title={r.title}
      id="asset-research"
      tight
      tags={
        r.head.kind === "sub" ? (
          <span className="text-xs-plus font-medium text-fg-muted">{r.head.text}</span>
        ) : (
          <Tag tone={tagTone[r.head.tone]}>{r.head.text}</Tag>
        )
      }
      controls={
        r.toggle ? (
          <button
            type="button"
            onClick={ui.onToggleOlder}
            className="cursor-pointer border-0 bg-transparent p-0 text-xs-plus text-accent underline underline-offset-2"
          >
            {r.toggle}
          </button>
        ) : undefined
      }
    >
      <div className="mb-0.5 grid grid-cols-[--spacing(37.5)_minmax(0,1fr)] items-center gap-4 border-b border-border pt-0.5 pb-2.5 max-narrow:grid-cols-1 max-narrow:gap-1.5">
        <div className="min-w-0">
          <div className="text-2xs uppercase tracking-label text-fg-muted">{r.sentiment.label}</div>
          <div
            className={`mt-px text-base font-heavy tracking-snug tabular-nums ${valueTone[r.sentiment.tone]}`}
          >
            {r.sentiment.value}
          </div>
        </div>
        <SentimentBars size="lg" {...r.sentiment.bars} />
      </div>
      {!r.rows.length ? (
        <div className="py-2 text-sm text-fg-muted">{r.empty}</div>
      ) : (
        r.rows.map((n) => (
          <NoteRow
            key={n.id}
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
                ? n.summary.map((part) =>
                    part.bold ? <b key={part.key}>{part.text}</b> : part.text,
                  )
                : undefined
            }
            onToggle={() => ui.onToggleNote(n.noteId)}
            restore={
              n.restore ? { ...n.restore, onRestore: () => ui.onRestore(n.noteId) } : undefined
            }
            dismiss={
              n.dismiss ? { ...n.dismiss, onDismiss: () => ui.onDismiss(n.noteId) } : undefined
            }
          />
        ))
      )}
    </Widget>
  );
}
