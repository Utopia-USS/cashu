import { D } from "@cashu/domain";
import { Amount, DateText, Percent } from "@cashu/ui";
import { useEffect, useRef } from "react";
import {
  type researchAssetModel,
  researchHealthLabel,
  researchRelationLabel,
  researchRunStatus,
} from "./presentation.js";
import { S } from "./Research.strings.js";

const button =
  "rounded-sm border border-border px-3 py-2 hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent";

/** Render-only asset slot; the Block owns Store reads, note age selection, and expansion state. */
export function AssetResearchSection({
  model,
  privacy,
  onOpenNote,
  onShowOlder,
}: {
  model: NonNullable<ReturnType<typeof researchAssetModel>>;
  privacy: boolean;
  onOpenNote(gid: string): void;
  onShowOlder(): void;
}) {
  const {
    data,
    summary,
    shown,
    hasOlder,
    focusedNote,
    runStatus,
    runDay,
    runFreshness,
    lastResearchDay,
  } = model;
  const focused = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focusedNote || privacy) return;
    focused.current?.scrollIntoView({ block: "center" });
    focused.current?.focus();
  }, [focusedNote, privacy, shown.length]);
  return (
    <section
      className="rounded-lg border border-border bg-surface-raised p-4"
      data-testid="native-asset-research"
    >
      <h2 className="font-strong">{S.title}</h2>
      {privacy ? (
        <p>{S.hidden}</p>
      ) : (
        <>
          {data.lastRun === null && <p>{S.noRun}</p>}
          {runStatus && (
            <p>
              {S.runs}: {researchRunStatus(runStatus)}
              {runFreshness === "stale" ? ` · ${S.outdated}` : ""}
              {runFreshness === "fresh" ? ` · ${S.freshRun}` : ""}
              {runDay && (
                <>
                  {" "}
                  · <DateText value={runDay} />
                </>
              )}
            </p>
          )}
          {lastResearchDay && (
            <p>
              {S.lastResearch}: <DateText value={lastResearchDay} />
            </p>
          )}
          {summary && (
            <>
              <p>
                {S.health}: {researchHealthLabel(summary.health)}
                {summary.health_predates_thesis ? ` · ${S.predatesThesis}` : ""}
              </p>
              <div className="mt-3">
                <h3 className="font-strong">{S.sentiment}</h3>
                <div className="flex flex-wrap gap-2">
                  {summary.sentiment_8w.map((value, index) => (
                    <span
                      key={
                        data.status === "current" && data.summary.status === "current"
                          ? (data.summary.value.weeks[index] ?? String(index))
                          : String(index)
                      }
                      className="rounded-sm border border-border px-2 py-1 text-sm"
                    >
                      {value === null ? S.noResearch : <Percent value={D(String(value))} />}
                    </span>
                  ))}
                </div>
              </div>
            </>
          )}
          {shown.length === 0 ? (
            <p>{S.noResearch}</p>
          ) : (
            <ul className="mt-3 grid gap-2">
              {shown.map(({ note, day }) => (
                <li
                  key={note.id}
                  className="flex justify-between gap-3 border-b border-border py-2"
                >
                  <button
                    type="button"
                    ref={note.id === focusedNote ? focused : undefined}
                    className="text-left text-accent underline"
                    onClick={() => onOpenNote(note.id)}
                  >
                    {note.title}
                  </button>
                  <DateText value={day} />
                  <span className="text-sm text-text-muted">
                    {researchRelationLabel(note.thesis_relation)}
                    {note.predates_thesis ? ` · ${S.predatesThesis}` : ""}
                    {note.kind === "community" ? ` · ${S.communityNoise}` : ""}
                    {note.expired ? ` · ${S.outdated}` : ""} · {S.strength}:{" "}
                    <Amount value={D(String(note.strength))} fractionDigits={0} /> · {S.sources}:{" "}
                    <Amount value={D(String(note.sources.length))} fractionDigits={0} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {hasOlder && (
            <button type="button" className={button} onClick={onShowOlder}>
              {S.showOlder}
            </button>
          )}
        </>
      )}
    </section>
  );
}
