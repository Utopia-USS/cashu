import { D, Money as MoneyValue } from "@cashu/domain";
import { Amount, DateText, Money, Percent } from "@cashu/ui";
import { reviewSourceMessage } from "./presentation.js";
import { R } from "./Review.strings.js";
import { ReviewDecideCard } from "./ReviewDecideCard.js";
import { ReviewIdeasCard } from "./ReviewIdeasCard.js";
import { Rows } from "./ReviewRows.js";
import { ReviewSummaryCard } from "./ReviewSummaryCard.js";
import type { ReviewScreenState } from "./useReviewScreen.js";

const button =
  "rounded-sm border border-border px-3 py-2 hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
const pct = (value: number | null) => (value === null ? null : D(String(value)));
function SourceFact({
  status,
  source,
}: {
  status: { readonly status: string; readonly reason?: string };
  source: string;
}) {
  const message = reviewSourceMessage(status, source);
  return message === null ? null : (
    <p role="status" className="text-sm text-fg-muted">
      {message}
    </p>
  );
}

export function CardContent({ state }: { state: ReviewScreenState }) {
  const session = state.session;
  if (!session) return null;
  const snapshot = session.snapshot;
  switch (state.card) {
    case "world":
      return (
        <>
          <h3 className="text-headline font-strong">
            {snapshot.world.verdict.size === null ? R.noValuation : R[snapshot.world.verdict.size]}
          </h3>
          {snapshot.world.verdict.vs && <p>{R[snapshot.world.verdict.vs]}</p>}
          <dl className="grid grid-cols-2 gap-3">
            <dt>{R.return}</dt>
            <dd>
              <Percent value={pct(snapshot.world.move)} />
            </dd>
            <dt>{R.valueChange}</dt>
            <dd>
              <Money
                value={
                  snapshot.digest.value.change === null
                    ? null
                    : new MoneyValue(snapshot.digest.value.change, snapshot.digest.value.currency)
                }
              />
            </dd>
            <dt>{R.benchmark}</dt>
            <dd>
              <Percent value={pct(snapshot.world.benchmark)} />
            </dd>
          </dl>
          {snapshot.world.benchmarkStale && <p>{R.benchmarkStale}</p>}
          <SourceFact status={snapshot.macro} source={R.macroData} />
          {state.riskMacro && (
            <section>
              {state.riskMacro.label}
              <p>{state.detail ? state.riskMacro.explain : state.riskMacro.summary}</p>
            </section>
          )}
          {snapshot.macro.status === "current" && state.riskMacro === null && (
            <p>{R.sourceMissing(R.macroData)}</p>
          )}
          {state.detail && (
            <>
              {snapshot.riskBrief && (
                <p>
                  <strong>{snapshot.riskBrief.headline}</strong> {snapshot.riskBrief.why}{" "}
                  <button
                    type="button"
                    className={button}
                    onClick={() => state.setReader(snapshot.riskBrief?.note ?? null)}
                  >
                    {R.fullNote}
                  </button>
                </p>
              )}
              <dl className="grid grid-cols-2 gap-3">
                <dt>{R.sigma}</dt>
                <dd>
                  <Percent value={pct(snapshot.world.sigma)} />
                </dd>
                <dt>{R.drawdown}</dt>
                <dd>
                  <Percent value={pct(snapshot.world.drawdown)} />
                </dd>
                <dt>{R.maxDrawdown}</dt>
                <dd>
                  <Percent value={pct(snapshot.world.maxDrawdown)} />
                </dd>
              </dl>
              <Rows rows={snapshot.briefs} rowKey={(row) => row.note} label={R.sources}>
                {(row) => (
                  <p>
                    {row.headline} {row.why}{" "}
                    <button
                      type="button"
                      className={button}
                      onClick={() => state.setReader(row.note)}
                    >
                      {R.fullNote}
                    </button>
                  </p>
                )}
              </Rows>
              <Rows
                rows={snapshot.macroChanges.slice(0, 2)}
                rowKey={(row) => row.key}
                label={R.events}
              >
                {(row) => (
                  <p>
                    {row.label}: {row.from} - {row.to} <DateText value={row.since} />
                  </p>
                )}
              </Rows>
            </>
          )}
        </>
      );
    case "sectors":
      return (
        <>
          <SourceFact status={snapshot.sources.segments} source={R.sectors} />
          <h3>
            {snapshot.sectorVerdict.code === "all_plus"
              ? R.allPlus
              : snapshot.sectorVerdict.code === "all_minus"
                ? R.allMinus
                : snapshot.sectorVerdict.code === "share"
                  ? R.sectorShare
                  : R.sectorSpread}
            : {snapshot.sectorVerdict.names.join(" · ")}
          </h3>
          <Rows rows={snapshot.sectors} rowKey={(row) => row.key} label={R.sectors}>
            {(row) => (
              <section>
                <h3>{row.currency ? R.currencies : row.label}</h3>
                <p>
                  {R.contribution}: <Percent value={pct(row.contribution)} />
                </p>
                {state.detail && (
                  <p>
                    {R.weight}: <Percent value={pct(row.weight)} /> · {R.return}:{" "}
                    <Percent value={pct(row.ret)} />
                  </p>
                )}
              </section>
            )}
          </Rows>
          {state.detail && (
            <Rows rows={snapshot.sectorBriefs} rowKey={(row) => row.note} label={R.sources}>
              {(row) => (
                <p>
                  {row.headline} {row.why}{" "}
                  <button
                    type="button"
                    className={button}
                    onClick={() => state.setReader(row.note)}
                  >
                    {R.fullNote}
                  </button>
                </p>
              )}
            </Rows>
          )}
        </>
      );
    case "positions":
      return (
        <Rows
          rows={
            state.detail ? snapshot.movers.all : [...snapshot.movers.down, ...snapshot.movers.up]
          }
          rowKey={(row) => row.id}
          label={R.positions}
        >
          {(row) => (
            <div className="flex flex-wrap justify-between gap-3">
              <button
                type="button"
                className="text-accent underline"
                onClick={() => state.onInstrumentOpened?.(row.id)}
              >
                {row.label}
              </button>
              <span>
                <Percent value={pct(row.ret)} />{" "}
                {state.detail && (
                  <>
                    {R.contribution}: <Percent value={pct(row.contribution)} />
                  </>
                )}
              </span>
            </div>
          )}
        </Rows>
      );
    case "events":
      return (
        <>
          <Rows rows={snapshot.events} rowKey={(row) => row.note.id} label={R.events}>
            {({ note }) => (
              <section>
                <h3 className="font-strong">{note.title}</h3>
                <p>{note.summary}</p>
                <DateText value={state.dates.notes[note.id] ?? null} />
                <button type="button" className={button} onClick={() => state.setReader(note.id)}>
                  {R.fullNote}
                </button>
              </section>
            )}
          </Rows>
          <SourceFact status={snapshot.sources.macro} source={R.macroData} />
          {snapshot.macroChanges.map((row) => (
            <p key={row.key}>
              {row.label}: {row.from} - {row.to}
              <DateText value={state.dates.macroChanges[row.key] ?? null} />
            </p>
          ))}
        </>
      );
    case "ideas":
      return <ReviewIdeasCard state={state} />;
    case "calendar":
      return (
        <>
          <SourceFact status={snapshot.calendar} source={R.calendar} />
          {snapshot.calendar.status === "current" && (
            <>
              {snapshot.calendar.value.events.length === 0 && <p>{R.noCalendar}</p>}
              <Rows
                rows={snapshot.calendar.value.events.slice(0, state.detail ? undefined : 8)}
                rowKey={(row) => `${row.date}:${row.kind}:${row.title}`}
                label={R.calendar}
              >
                {(row) => (
                  <p>
                    <DateText value={row.date} /> {row.time} · {row.title} {row.country_label}{" "}
                    {row.label}{" "}
                    {row.held === true
                      ? R.heldAsset
                      : row.held === false && row.instrument_id !== null
                        ? R.watchedAsset
                        : ""}{" "}
                    {row.kind === "research" ? R.researchEvent : ""}
                    {row.note_id && (
                      <button
                        type="button"
                        className={button}
                        onClick={() => state.setReader(row.note_id)}
                      >
                        {R.fullNote}
                      </button>
                    )}
                  </p>
                )}
              </Rows>
              {snapshot.calendar.value.stale && <p>{R.stale}</p>}
              {snapshot.calendar.value.errors.length > 0 && (
                <>
                  <p>{R.unavailable}</p>
                  <p>
                    {R.calendarErrors}:{" "}
                    <Amount
                      value={D(String(snapshot.calendar.value.errors.length))}
                      fractionDigits={0}
                    />
                  </p>
                </>
              )}
              <p>
                {R.fetched}: <DateText value={state.dates.calendarFetched} />
              </p>
            </>
          )}
          <p>{R.calendarSources}</p>
        </>
      );
    case "decide":
      return <ReviewDecideCard state={state} />;
    case "summary":
      return <ReviewSummaryCard state={state} />;
  }
}
