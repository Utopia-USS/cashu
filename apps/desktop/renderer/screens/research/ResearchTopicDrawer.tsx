import { Button, DateText, Modal, useVirtualRows } from "@cashu/ui";
import { useRef } from "react";
import type { researchTopicModel } from "./presentation.js";
import { S } from "./Research.strings.js";
import { ResearchValuationFacts } from "./ResearchValuationFacts.js";
import type { ResearchScreenState } from "./useResearchScreen.js";

export function ResearchTopicDrawer({
  state,
  model,
  onOpenNote,
}: {
  state: ResearchScreenState;
  model: NonNullable<ReturnType<typeof researchTopicModel>>;
  onOpenNote(gid: string): void;
}) {
  const {
    title,
    isMacro,
    macro,
    members,
    related,
    viewUpdatedDay,
    viewSources,
    valuationDay,
    valuationFacts,
    valuationSources,
    macroSupports,
    macroRisks,
  } = model;
  const relatedRef = useRef<HTMLElement>(null);
  const relatedRows = useVirtualRows({
    count: related.length,
    getScrollElement: () => relatedRef.current,
    estimateSize: () => 64,
    getItemKey: (index) => related[index]?.note.id ?? String(index),
    overscan: 6,
  });
  return (
    <Modal label={title} onClose={() => state.setTopic(null)} placement="center">
      <div className="flex justify-between gap-3">
        <h2 className="text-headline font-strong">{title}</h2>
        <Button onPress={() => state.setTopic(null)}>{S.close}</Button>
      </div>
      {state.privacy ? (
        <p>{S.hidden}</p>
      ) : (
        <>
          {isMacro ? (
            macro ? (
              <div className="mt-4 grid gap-2">
                <p>{macro.summary}</p>
                <p>{macro.explain}</p>
                {macro.brief && (
                  <div className="rounded-sm bg-surface-sunken p-3">
                    <h3 className="font-strong">
                      {typeof macro.brief.headline === "string" ? macro.brief.headline : S.macro}
                    </h3>
                    <p>{typeof macro.brief.why === "string" ? macro.brief.why : ""}</p>
                    {macroSupports.length > 0 && (
                      <p>
                        {S.supports}: {macroSupports.join(", ")}
                      </p>
                    )}
                    {macroRisks.length > 0 && (
                      <p>
                        {S.risks}: {macroRisks.join(", ")}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <p>{S.unavailableMacro}</p>
            )
          ) : (
            <>
              {state.topicRecord?.draft && <p className="mt-3">{S.draft}</p>}
              {viewUpdatedDay && (
                <p className="mt-3 text-sm text-text-muted">
                  <DateText value={viewUpdatedDay} />
                </p>
              )}
              {viewSources.length > 0 && (
                <div className="mt-2 text-sm">
                  <h3 className="font-strong">{S.sources}</h3>
                  <ul>
                    {viewSources.map((source) => (
                      <li key={source.key}>
                        {source.url ? (
                          <a
                            className="text-accent underline"
                            href={source.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {source.title}
                          </a>
                        ) : (
                          source.title
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {valuationDay && (
                <p className="mt-2 text-sm">
                  {S.valuation}: <DateText value={valuationDay} />
                  {valuationSources.length > 0 ? ` · ${valuationSources.join(", ")}` : ""}
                </p>
              )}
              <ResearchValuationFacts facts={valuationFacts} />
              <div className="mt-4 grid gap-3">
                <label>
                  {S.thesis}
                  <textarea
                    className="block w-full rounded-sm border border-border bg-surface p-2"
                    maxLength={600}
                    value={state.topicForm.thesis}
                    onChange={(e) =>
                      state.setTopicForm({ ...state.topicForm, thesis: e.target.value })
                    }
                  />
                </label>
                <label>
                  {S.invalidation}
                  <textarea
                    className="block w-full rounded-sm border border-border bg-surface p-2"
                    maxLength={400}
                    value={state.topicForm.invalidation}
                    onChange={(e) =>
                      state.setTopicForm({ ...state.topicForm, invalidation: e.target.value })
                    }
                  />
                </label>
                <label>
                  {S.assessment}
                  <textarea
                    className="block w-full rounded-sm border border-border bg-surface p-2"
                    maxLength={400}
                    value={state.topicForm.assessment}
                    onChange={(e) =>
                      state.setTopicForm({ ...state.topicForm, assessment: e.target.value })
                    }
                  />
                </label>
                <label>
                  {S.outlook}
                  <textarea
                    className="block w-full rounded-sm border border-border bg-surface p-2"
                    maxLength={400}
                    value={state.topicForm.outlook}
                    onChange={(e) =>
                      state.setTopicForm({ ...state.topicForm, outlook: e.target.value })
                    }
                  />
                </label>
              </div>
              {state.topicRecord?.draft && (
                <label className="mt-3 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={state.topicForm.confirmDraft}
                    onChange={(e) =>
                      state.setTopicForm({ ...state.topicForm, confirmDraft: e.target.checked })
                    }
                  />
                  {S.confirmDraft}
                </label>
              )}
              {viewSources.length > 0 && (
                <label className="mt-3 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={state.topicForm.clearSources}
                    onChange={(e) =>
                      state.setTopicForm({ ...state.topicForm, clearSources: e.target.checked })
                    }
                  />
                  {S.clearSources}
                </label>
              )}
              <div className="mt-3 flex gap-2">
                <Button
                  disabled={state.busy}
                  onPress={() => {
                    void state.saveTopic();
                  }}
                >
                  {S.save}
                </Button>
                <Button onPress={() => state.setTopic(null)}>{S.cancel}</Button>
              </div>
              {members.length > 0 && (
                <div className="mt-4">
                  <h3 className="font-strong">{S.mine}</h3>
                  <div className="flex flex-wrap gap-2">
                    {members.map((member) => (
                      <Button
                        key={member.instrument_id}
                        onPress={() => state.openAsset(member.instrument_id)}
                      >
                        {member.label ?? member.instrument_id}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          <h3 className="mt-4 font-strong">{S.notes}</h3>
          {related.length === 0 ? (
            <p>{S.noNotes}</p>
          ) : (
            <section ref={relatedRef} aria-label={S.notes} className="max-h-96 overflow-auto">
              <ul className="relative" style={{ height: relatedRows.totalSize }}>
                {relatedRows.items.map((item) => {
                  const row = related[item.index];
                  if (!row) return null;
                  return (
                    <li
                      key={item.key}
                      ref={relatedRows.measureElement}
                      data-index={item.index}
                      className="absolute left-0 top-0 w-full border-b border-border py-2"
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      <button
                        type="button"
                        className="text-left text-accent underline"
                        onClick={() => onOpenNote(row.note.id)}
                      >
                        {row.note.title}
                      </button>
                      <span className="ml-2 text-sm text-text-muted">
                        <DateText value={row.day} />
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </Modal>
  );
}
