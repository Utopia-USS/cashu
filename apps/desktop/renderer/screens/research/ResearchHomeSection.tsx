import { D } from "@cashu/domain";
import type { ResearchScreenSnapshot } from "@cashu/store/investments/research-screen";
import { Amount, Button, Card, DateText, Percent } from "@cashu/ui";
import { researchHomeModel } from "./presentation.js";
import { S } from "./Research.strings.js";
import { ResearchValuationFacts } from "./ResearchValuationFacts.js";

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
    <Card testID="native-research-story">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-strong">{S.title}</h2>
        <Button onPress={() => onOpenResearch()}>{S.all}</Button>
      </div>
      {privacy ? (
        <p>{S.hidden}</p>
      ) : (
        <>
          {data.macro.status === "current" && <p className="mt-3">{riskSummary ?? ""}</p>}
          {data.macro.status === "current" ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {data.macro.value.map((regime) => (
                <Button key={regime.key} onPress={() => onOpenTopic(`macro_${regime.key}`)}>
                  {regime.label}: {regime.state_label}
                </Button>
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
                      <Button
                        key={row.instrument_id}
                        onPress={() => onOpenAsset(row.instrument_id)}
                      >
                        {row.label}
                      </Button>
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
                        <Button key={row.segment} onPress={() => onOpenTopic(row.segment)}>
                          {row.label}
                        </Button>
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
    </Card>
  );
}
