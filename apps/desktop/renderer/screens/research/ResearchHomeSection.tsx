import { D } from "@cashu/domain";
import type { ResearchScreenSnapshot } from "@cashu/store/investments/research-screen";
import { Amount, DateText, Percent } from "@cashu/ui";
import { researchCandidateRail, researchHomeModel } from "./presentation.js";
import { S } from "./Research.strings.js";
import { ResearchValuationFacts } from "./ResearchValuationFacts.js";
import { useResearchCandidatesRail } from "./useResearchCandidatesRail.js";

const card = "rounded-lg border border-border bg-surface-raised p-4";
const button =
  "rounded-sm border border-border px-3 py-2 hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent";
type HomeProps = {
  data: ResearchScreenSnapshot;
  privacy: boolean;
  onOpenResearch(tab?: string): void;
  onOpenTopic(key: string): void;
  onOpenAsset(instrument: string, note?: string): void;
};

/** The current Home story, fed by the same tracked Research query as the six tabs. */
export function ResearchHomeSection(props: HomeProps) {
  const model = researchHomeModel(props.data);
  return model === null ? null : <ResearchHomeView {...props} model={model} />;
}

function ResearchHomeView({
  model,
  privacy,
  onOpenResearch,
  onOpenTopic,
  onOpenAsset,
}: Omit<HomeProps, "data"> & { model: NonNullable<ReturnType<typeof researchHomeModel>> }) {
  const { data, weak, events, quiet, draftCount, topics, riskSummary } = model;
  return (
    <section className={card} data-testid="native-research-story">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-strong">{S.title}</h2>
        <button type="button" className={button} onClick={() => onOpenResearch()}>
          {S.all}
        </button>
      </div>
      {privacy ? (
        <p>{S.hidden}</p>
      ) : (
        <>
          {data.macro.status === "current" && <p className="mt-3">{riskSummary ?? ""}</p>}
          {data.macro.status === "current" ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {data.macro.value.map((regime) => (
                <button
                  type="button"
                  key={regime.key}
                  className={button}
                  onClick={() => onOpenTopic(`macro_${regime.key}`)}
                >
                  {regime.label}: {regime.state_label}
                </button>
              ))}
            </div>
          ) : (
            <p>{S.unavailableMacro}</p>
          )}
          {data.lastRun !== null && (
            <>
              {weak.length > 0 && (
                <div className="mt-3">
                  <h3 className="font-strong">{S.thesisMoves}</h3>
                  <div className="flex flex-wrap gap-2">
                    {weak.map((row) => (
                      <button
                        type="button"
                        key={row.instrument_id}
                        className={button}
                        onClick={() => onOpenAsset(row.instrument_id)}
                      >
                        {row.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="mt-3">
                <h3 className="font-strong">{S.topics}</h3>
                {topics.length === 0 ? (
                  <p>{S.noTopics}</p>
                ) : (
                  <div className="grid gap-2">
                    {topics.map((topic) => (
                      <button
                        type="button"
                        key={topic.segment}
                        className="border-b border-border py-2 text-left"
                        onClick={() => onOpenTopic(topic.segment)}
                      >
                        <span className="flex justify-between gap-3">
                          <strong>{topic.label}</strong>
                          <Percent value={D(String(topic.contribution))} />
                        </span>
                        {topic.headline && <span className="block text-sm">{topic.headline}</span>}
                        {topic.outlook && (
                          <span className="block text-sm text-text-muted">{topic.outlook}</span>
                        )}
                        {topic.valuation && (
                          <>
                            <span className="block text-sm text-text-muted">
                              {S.valuation}: <DateText value={topic.valuationDay} />
                            </span>
                            <ResearchValuationFacts facts={topic.valuationFacts} />
                          </>
                        )}
                        {topic.note_this_week && (
                          <span className="block text-sm text-text-muted">{S.latest}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {draftCount > 0 && (
                  <p className="mt-2">
                    {S.draft}: <Amount value={D(String(draftCount))} fractionDigits={0} />
                  </p>
                )}
                {quiet.length > 0 && (
                  <div className="mt-2">
                    <h4 className="font-strong">{S.quietTopics}</h4>
                    <div className="flex flex-wrap gap-2">
                      {quiet.map((row) => (
                        <button
                          type="button"
                          key={row.segment}
                          className={button}
                          onClick={() => onOpenTopic(row.segment)}
                        >
                          {row.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="mt-3">
                <h3 className="font-strong">{S.upcoming}</h3>
                {data.calendar.status !== "current" ? (
                  <p>{S.unavailableCalendar}</p>
                ) : events.length === 0 ? (
                  <p>{S.noEvents}</p>
                ) : (
                  <div className="grid gap-2">
                    {events.map((event, index) => (
                      <div
                        key={`${event.date}:${event.kind}:${event.note_id ?? index}`}
                        className="flex gap-3"
                      >
                        <DateText value={event.date} />
                        <span>{event.title}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** The Home candidate rail uses actual accepted/dismissed candidate notes. */
export function ResearchCandidatesRail({
  data,
  privacy,
  onOpenResearch,
  onOpenNote,
}: {
  data: ResearchScreenSnapshot;
  privacy: boolean;
  onOpenResearch(tab?: string): void;
  onOpenNote(gid: string): void;
}) {
  const actions = useResearchCandidatesRail();
  const candidates = researchCandidateRail(data);
  if (candidates === null) return null;
  return (
    <ResearchCandidatesView
      candidates={candidates}
      privacy={privacy}
      onOpenResearch={onOpenResearch}
      onOpenNote={onOpenNote}
      actions={actions}
    />
  );
}

function ResearchCandidatesView({
  candidates,
  privacy,
  onOpenResearch,
  onOpenNote,
  actions,
}: {
  candidates: NonNullable<ReturnType<typeof researchCandidateRail>>;
  privacy: boolean;
  onOpenResearch(tab?: string): void;
  onOpenNote(gid: string): void;
  actions: ReturnType<typeof useResearchCandidatesRail>;
}) {
  return (
    <section className={card}>
      <div className="flex justify-between">
        <h2 className="font-strong">{S.candidates}</h2>
        <button type="button" className={button} onClick={() => onOpenResearch("candidates")}>
          {S.allCandidates}
        </button>
      </div>
      {actions.notice && <p role="status">{actions.notice}</p>}
      {privacy ? (
        <p>{S.hidden}</p>
      ) : candidates.length === 0 ? (
        <p>{S.noCandidates}</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {candidates.map(({ note, day, facts }) => (
            <li key={note.id}>
              <button
                type="button"
                className="text-left text-accent underline"
                onClick={() => onOpenNote(note.id)}
              >
                {note.title}
              </button>
              <span className="ml-2 text-sm text-text-muted">
                <DateText value={day} />
              </span>
              <div className="mt-1 text-sm text-text-muted">
                {facts.candidateName ?? facts.candidateSymbol}
                {facts.candidateName && facts.candidateSymbol ? ` (${facts.candidateSymbol})` : ""}
                {note.created_by === "agent" ? ` · ${S.agentNote}` : ""}
              </div>
              <details className="mt-2 text-sm">
                <summary>{S.details}</summary>
                {facts.context && (
                  <p>
                    {S.context}: {facts.context}
                  </p>
                )}
                {facts.criteria.length > 0 && (
                  <ul className="list-disc pl-5">
                    {facts.criteria.map((criterion) => (
                      <li key={criterion.text}>
                        {criterion.met ? S.met : S.notMet}: {criterion.text}
                      </li>
                    ))}
                  </ul>
                )}
              </details>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className={button}
                  disabled={actions.busy || note.instrument_id === null}
                  onClick={() => actions.watch(note.id, note.instrument_id)}
                >
                  {S.watch}
                </button>
                <button
                  type="button"
                  className={button}
                  disabled={actions.busy}
                  onClick={() => {
                    void actions.dismiss(note.id);
                  }}
                >
                  {S.dismiss}
                </button>
              </div>
              {note.instrument_id === null && (
                <p className="text-sm text-text-muted">{S.resolutionUnavailable}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      <span className="sr-only">
        <Amount value={D(String(candidates.length))} fractionDigits={0} />
      </span>
    </section>
  );
}
