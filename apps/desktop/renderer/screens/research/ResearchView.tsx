import { D } from "@cashu/domain";
import { Amount, Button, Card, DateText, Percent } from "@cashu/ui";
import { useRef } from "react";
import { useVirtualRows } from "../../presentation/useVirtualRows.js";
import { type ResearchNoteRow, researchHealthLabel, researchRunStatus } from "./presentation.js";
import { S } from "./Research.strings.js";
import { ResearchNoteView } from "./ResearchNoteView.js";
import { ResearchTopicDrawer } from "./ResearchTopicDrawer.js";
import { ResearchValuationFacts } from "./ResearchValuationFacts.js";
import type { ResearchScreenState, ResearchTab } from "./useResearchScreen.js";

const tabs: readonly [ResearchTab, string][] = [
  ["topics", S.topics],
  ["mine", S.mine],
  ["notes", S.notes],
  ["calendar", S.calendar],
  ["candidates", S.candidates],
  ["runs", S.runs],
];
const num = (value: number) => <Amount value={D(String(value))} fractionDigits={0} />;
const pct = (value: number | null) =>
  value === null ? S.unavailableMarket : <Percent value={D(String(value))} />;

function NoteRows({
  rows,
  onOpen,
}: {
  rows: readonly ResearchNoteRow[];
  onOpen(gid: string): void;
}) {
  const ref = useRef<HTMLElement>(null);
  const virtual = useVirtualRows({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 66,
    getItemKey: (index) => {
      const item = rows[index];
      return item?.kind === "note" ? item.note.id : (item?.day ?? String(index));
    },
    overscan: 6,
  });
  return (
    <section ref={ref} aria-label={S.notes} className="max-h-96 overflow-auto">
      <div className="relative" style={{ height: virtual.totalSize }}>
        {virtual.items.map((item) => {
          const entry = rows[item.index];
          if (entry?.kind === "day")
            return (
              <h3
                key={item.key}
                ref={virtual.measureElement}
                data-index={item.index}
                className="absolute left-0 top-0 w-full border-b border-border bg-surface-sunken px-3 py-2 font-strong"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <DateText value={entry.day} />
              </h3>
            );
          const row = entry?.kind === "note" ? entry.note : null;
          return row ? (
            <button
              type="button"
              key={item.key}
              ref={virtual.measureElement}
              data-index={item.index}
              className="absolute left-0 top-0 flex w-full items-start justify-between gap-3 border-b border-border p-3 text-left hover:bg-surface-sunken"
              style={{ transform: `translateY(${item.start}px)` }}
              onClick={() => onOpen(row.id)}
            >
              <span className="min-w-0">
                <strong className="block truncate">{row.title}</strong>
                <span className="block truncate text-sm text-text-muted">{row.summary}</span>
              </span>
              <span className="shrink-0 text-sm">
                <DateText value={entry?.kind === "note" ? entry.observedDay : null} />
              </span>
            </button>
          ) : null;
        })}
      </div>
    </section>
  );
}

export function ResearchView({ state }: { state: ResearchScreenState }) {
  const data = state.data;
  const { noteGroups, candidates, runs, opened, hasRun, filteredCount, shownCount, held } =
    state.display;
  return (
    <main className="grid gap-6 p-6" data-testid="native-research">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Button onPress={state.onBack}>{S.back}</Button>
          <h1 className="mt-2 text-headline font-strong">{S.title}</h1>
        </div>
        <Button
          disabled={
            state.privacy ||
            data.status !== "current" ||
            data.workspace.status !== "current" ||
            !data.workspace.value.command
          }
          onPress={state.copyRun}
        >
          {S.runNow}
        </Button>
      </header>
      {state.notice && (
        <Card as="p" role="status">
          {state.notice}
        </Card>
      )}
      {data.status === "unavailable" ? (
        <Card>{S.unavailable}</Card>
      ) : (
        <>
          {data.status === "partial" && <Card>{S.unavailableMarket}</Card>}
          {!hasRun && (
            <Card>
              <h2 className="font-strong">{S.noRun}</h2>
              <ol className="mt-3 list-decimal pl-5">
                <li>{S.setupSkill}</li>
                <li>{S.setupFirst}</li>
                <li>{S.setupSchedule}</li>
              </ol>
              <p className="mt-3">
                {data.workspace.status !== "current"
                  ? S.unavailableWorkspace
                  : data.workspace.value.exists && data.workspace.value.skillInstalled
                    ? S.workspaceReady
                    : S.workspaceMissing}
              </p>
              <Button onPress={state.onSettings}>{S.routine}</Button>
            </Card>
          )}
          <nav aria-label={S.title} className="flex flex-wrap gap-2">
            {tabs.map(([id, label]) => (
              <Button
                key={id}
                current={state.tab === id ? "page" : undefined}
                onPress={() => state.setTab(id)}
              >
                {label}
              </Button>
            ))}
          </nav>
          {state.privacy ? (
            <Card>{S.hidden}</Card>
          ) : (
            <>
              {state.tab === "topics" && (
                <Card>
                  <h2 className="mb-3 font-strong">{S.topics}</h2>
                  {state.display.topics === null ? (
                    <p>{S.unavailableMarket}</p>
                  ) : state.display.topics.length === 0 ? (
                    <p>{S.noTopics}</p>
                  ) : (
                    <ul className="grid gap-2">
                      {state.display.topics.map((segment) => (
                        <li key={segment.segment} className="border-b border-border py-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <button
                              type="button"
                              className="text-left font-strong text-accent underline"
                              onClick={() => state.openTopic(segment.segment)}
                            >
                              {segment.label}
                            </button>
                            <span>
                              {S.weight}: {pct(segment.weight)}
                            </span>
                            <span>
                              {S.contribution}: {pct(segment.contribution)}
                            </span>
                          </div>
                          {segment.headline && <p className="mt-1">{segment.headline}</p>}
                          {segment.assessment && (
                            <p className="mt-1 text-sm">
                              {S.assessment}: {segment.assessment}
                            </p>
                          )}
                          {segment.outlook && (
                            <p className="mt-1 text-sm">
                              {S.outlook}: {segment.outlook}
                            </p>
                          )}
                          <div className="mt-1 flex flex-wrap gap-3 text-sm text-text-muted">
                            {segment.note_this_week && <span>{S.latest}</span>}
                            {segment.quiet && <span>{S.quietTopics}</span>}
                            {segment.draft && <span>{S.draft}</span>}
                            {segment.valuation && (
                              <span>
                                {S.valuation}: <DateText value={segment.valuationDay} />
                                {segment.valuationSource ? ` · ${segment.valuationSource}` : ""}
                                <ResearchValuationFacts facts={segment.valuationFacts} />
                              </span>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {data.status === "current" && data.macro.status === "current" && (
                    <div className="mt-4">
                      <h3 className="font-strong">{S.macro}</h3>
                      <div className="flex flex-wrap gap-2">
                        {data.macro.value.map((regime) => (
                          <Button
                            key={regime.key}
                            onPress={() => state.openTopic(`macro_${regime.key}`)}
                          >
                            {regime.label}: {regime.state_label}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                </Card>
              )}
              {state.tab === "mine" && (
                <Card>
                  <h2 className="mb-3 font-strong">{S.mine}</h2>
                  {held === null ? (
                    <p>{S.unavailableMarket}</p>
                  ) : held.length === 0 ? (
                    <p>{S.noHoldings}</p>
                  ) : (
                    <ul className="grid gap-2">
                      {held.map((row) => (
                        <li
                          key={row.instrument_id}
                          className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-2"
                        >
                          <button
                            type="button"
                            className="text-left font-strong text-accent underline"
                            onClick={() => state.openAsset(row.instrument_id)}
                          >
                            {row.label}
                          </button>
                          <span>
                            {S.health}: {researchHealthLabel(row.health)}
                          </span>
                          <span>
                            {S.weight}: {pct(row.weight)}
                          </span>
                          <span>
                            {S.notes}: {num(row.notes)}
                          </span>
                          {row.earnings && (
                            <span>
                              {S.upcoming}: <DateText value={row.earnings.date} />{" "}
                              {row.earnings.title}
                            </span>
                          )}
                          {row.latest_note && (
                            <Button onPress={() => state.openNote(row.latest_note?.id as string)}>
                              {S.latest}
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              )}
              {state.tab === "notes" && (
                <Card>
                  <h2 className="mb-3 font-strong">{S.notes}</h2>
                  <div className="mb-3 flex flex-wrap gap-2">
                    {(["all", "thesis", "earnings", "news"] as const).map((key) => (
                      <Button
                        key={key}
                        pressed={state.noteFilter === key}
                        onPress={() => state.setNoteFilter(key)}
                      >
                        {
                          {
                            all: S.all,
                            thesis: S.thesisFilter,
                            earnings: S.earningsFilter,
                            news: S.newsFilter,
                          }[key]
                        }
                      </Button>
                    ))}
                  </div>
                  {shownCount ? (
                    <NoteRows rows={noteGroups} onOpen={state.openNote} />
                  ) : (
                    <p>{S.noNotes}</p>
                  )}
                  {shownCount < filteredCount && <Button onPress={state.showMore}>{S.more}</Button>}
                </Card>
              )}
              {state.tab === "calendar" && (
                <Card>
                  <h2 className="mb-3 font-strong">{S.calendar}</h2>
                  {state.display.calendar === null ? (
                    <p>{S.unavailableCalendar}</p>
                  ) : (
                    <>
                      {state.display.calendar.stale && <p role="status">{S.outdated}</p>}
                      {state.display.calendar.errors.length > 0 && (
                        <p role="status">{state.display.calendar.errors.join(", ")}</p>
                      )}
                      <p>
                        {S.weekEvents}: {num(state.display.calendar.weekCount)}
                      </p>
                      {state.display.calendar.days.length === 0 ? (
                        <p>{S.noEvents}</p>
                      ) : (
                        <ul className="grid gap-2">
                          {state.display.calendar.days.map((day) => (
                            <li key={day.date} className="border-b border-border py-3">
                              <h3 className="font-strong">
                                <DateText value={day.date} />
                              </h3>
                              {day.groups.map((group) => (
                                <div key={group.kind} className="mt-2">
                                  <h4 className="text-sm font-strong">
                                    {
                                      {
                                        earnings: S.earningsFilter,
                                        macro: S.macro,
                                        research: S.notes,
                                      }[group.kind]
                                    }
                                  </h4>
                                  <ul>
                                    {group.events.map((event) => (
                                      <li
                                        key={JSON.stringify(event)}
                                        className="flex flex-wrap justify-between gap-3 py-1"
                                      >
                                        <span>
                                          {event.time ?? ""} {event.title}
                                          {event.held === true ? ` · ${S.heldEarnings}` : ""}
                                        </span>
                                        {event.note_id && (
                                          <Button
                                            onPress={() => state.openNote(event.note_id as string)}
                                          >
                                            {S.details}
                                          </Button>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              ))}
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </Card>
              )}
              {state.tab === "candidates" && (
                <Card>
                  <h2 className="mb-3 font-strong">{S.candidates}</h2>
                  {candidates.length === 0 ? (
                    <p>{S.noCandidates}</p>
                  ) : (
                    <NoteRows rows={candidates} onOpen={state.openNote} />
                  )}
                </Card>
              )}
              {state.tab === "runs" && (
                <Card>
                  <h2 className="mb-3 font-strong">{S.runs}</h2>
                  {state.display.scope && (
                    <div className="mb-3 flex flex-wrap gap-4 rounded-sm bg-surface-sunken p-3 text-sm">
                      <span>
                        {S.heldScope}:{" "}
                        {state.display.scope.held === null
                          ? S.unavailableMarket
                          : num(state.display.scope.held)}
                      </span>
                      <span>
                        {S.watchedScope}:{" "}
                        {state.display.scope.watched === null
                          ? S.unavailableMarket
                          : num(state.display.scope.watched)}
                      </span>
                      <span>
                        {S.strategyVersion}:{" "}
                        {state.display.scope.strategyVersion === null
                          ? S.unknown
                          : num(state.display.scope.strategyVersion)}
                      </span>
                      {state.display.scope.strategyChanged && <span>{S.strategyChanged}</span>}
                      <span>{S.privacyScope}</span>
                    </div>
                  )}
                  {runs.length === 0 ? (
                    <p>{S.noRuns}</p>
                  ) : (
                    <ul className="grid gap-2">
                      {runs.map(({ run, day, scope }) => (
                        <li key={run.id} className="border-b border-border py-3">
                          <div className="flex flex-wrap justify-between gap-3">
                            <DateText value={day} />
                            <strong>{researchRunStatus(run.status)}</strong>
                            <span>{run.scheduled ? S.scheduled : S.onDemand}</span>
                            <span>
                              {S.creator}: {run.created_by}
                            </span>
                          </div>
                          <p className="mt-2 text-sm">
                            {S.scope}: {scope}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-4 text-sm">
                            <span>
                              {S.notes}: {num(run.notes)}
                            </span>
                            <span>
                              {S.signals}: {num(run.signals)}
                            </span>
                            <span>
                              {S.duration}:{" "}
                              {run.duration_s === null ? S.unknown : num(run.duration_s)}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-3">
                    {data.workspace.status === "current"
                      ? (data.workspace.value.path ?? S.unavailableWorkspace)
                      : S.unavailableWorkspace}
                  </p>
                  <p>
                    {data.workspace.status === "current"
                      ? (data.workspace.value.routine ?? S.routine)
                      : S.routine}
                  </p>
                </Card>
              )}
            </>
          )}
        </>
      )}
      {opened && (
        <ResearchNoteView
          note={opened.note}
          dates={opened.dates}
          facts={opened.facts}
          privacy={state.privacy}
          onClose={() => state.setNote(null)}
          onOpenAsset={state.openAsset}
          onOpenTopic={state.openTopic}
          onDismiss={(gid) => {
            void state.dismiss(gid);
          }}
          onRestore={(gid) => {
            void state.restore(gid);
          }}
          onAccept={(gid, instrument) => {
            void state.accept(gid, instrument);
          }}
          onUndoAccept={(gid) => {
            void state.undoAccept(gid);
          }}
          busy={state.busy}
        />
      )}
      {state.display.topic && (
        <ResearchTopicDrawer
          state={state}
          model={state.display.topic}
          onOpenNote={state.openNote}
        />
      )}
    </main>
  );
}
