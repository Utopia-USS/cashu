// Pure pieces of the research page (ab24ab6 research/Story.tsx page parts with story.css, Page.tsx widgets and
// research.css `.sched`, `.rsch-empty`, `.kvl`): the story head with the tabs and one widget per tab. Props come
// pre-formatted from researchPageModel.ts.
import { S } from "@cashu/i18n/investments/v2/research/Page.strings";
import { S as P } from "@cashu/i18n/investments/v2/research/primitives.strings";
import { S as T } from "@cashu/i18n/investments/v2/research/Story.strings";
import {
  Button,
  CandidateCard,
  CommandCode,
  CopyCommand,
  type SetupStepItem,
  SetupSteps,
  Tag,
  tableCls,
  tdCls,
  thCls,
  Widget,
} from "@cashu/ui";
import { AheadDays, Mood, NowOutlook } from "../investments/home/research/storyParts.js";
import type {
  CopyModel,
  EmptyModel,
  ScheduleModel,
  StoryHeadModel,
  StoryTab,
  TabModel,
} from "./researchPageModel.js";

type Tab<K extends TabModel["kind"]> = Extract<TabModel, { kind: K }>;

export function Copy({ c }: { c: CopyModel }) {
  return (
    <CopyCommand
      command={c.command}
      label={c.label}
      primary={c.primary}
      showCommand={c.showCommand}
      size={c.size}
      title={c.title}
      onCopy={c.onCopy}
    />
  );
}

// story.css `.st-sent` tones.
const sentTone = {
  neg: "bg-negative-bg text-negative",
  pos: "bg-positive-bg text-positive",
  info: "bg-info-bg text-info",
  "": "bg-chip text-chip-fg",
} as const;

/** `.st.st-head`: the summary sentence, the week's moves, the next run and the tabs. */
export function StoryHead({ m, onTab }: { m: StoryHeadModel; onTab(tab: StoryTab): void }) {
  return (
    <Widget title={null} label={S.research} tight>
      <p className="m-0 mb-3 max-w-story text-balance text-3xl-plus font-bold leading-tight tracking-snug max-story:text-xl">
        {m.story}
      </p>
      <div className="flex flex-wrap gap-2">
        {m.sents.map((s) => (
          <span
            key={s.text}
            className={`rounded-md px-3 py-1.5 text-sm font-strong ${sentTone[s.tone]}`}
          >
            {s.text}
          </span>
        ))}
      </div>
      <div className="mt-2.5 text-xs text-fg-muted">{m.next}</div>
      <div
        role="tablist"
        aria-label={T.tabs}
        className="mt-4 flex gap-0.5 overflow-x-auto border-b border-border"
      >
        {m.tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.selected}
            onClick={() => onTab(t.key)}
            className="cursor-pointer whitespace-nowrap border-0 border-b-2 border-transparent bg-transparent px-3 py-2 text-sm font-strong text-fg-muted aria-selected:border-fg aria-selected:text-fg"
          >
            {t.label}
          </button>
        ))}
      </div>
    </Widget>
  );
}

/** `.st-nlink`: a note headline as a bare link. */
const noteLink =
  "cursor-pointer border-0 bg-transparent px-0 py-0.5 text-left text-sm text-fg hover:text-accent";

export function TopicsTab({ m }: { m: Tab<"topics"> }) {
  return (
    <Widget
      title={T.tabTopics}
      tight
      footer={m.quiet ? <span className="text-fg-muted">{m.quiet}</span> : undefined}
    >
      <div className="grid grid-cols-2 gap-3 max-story:grid-cols-1">
        {m.cards.map((t) => (
          <article
            key={t.key}
            data-topic={t.key}
            className="grid content-start gap-2.25 rounded-widget border border-border px-3.75 py-3.25"
          >
            <div className="flex items-center gap-2 text-xs font-strong text-fg-muted">
              <Mood tone={t.mood.tone}>{t.mood.word}</Mood>
              <span>{t.label}</span>
              <span className="flex-1" />
              {t.draft && <span className="text-2xs font-strong text-warning">{t.draft}</span>}
              <span>{t.impact}</span>
            </div>
            <h3 className="m-0 text-balance text-base-plus font-bold leading-row">
              <button
                type="button"
                onClick={t.onOpen}
                className="cursor-pointer border-0 bg-transparent p-0 text-left text-fg hover:text-accent"
              >
                {t.headline}
              </button>
            </h3>
            <NowOutlook t={t.outlook} />
            {t.notes.length > 0 && (
              <div className="grid justify-items-start gap-0.5">
                {t.notes.map((n) => (
                  <button key={n.id} type="button" className={noteLink} onClick={n.onOpen}>
                    {n.text}
                  </button>
                ))}
              </div>
            )}
            {t.tickers && <div className="text-2xs tracking-column text-fg-muted">{t.tickers}</div>}
          </article>
        ))}
      </div>
    </Widget>
  );
}

const healthTone = { neg: "text-negative", pos: "text-positive", calm: "text-fg-muted" } as const;

export function MineTab({ m }: { m: Tab<"mine"> }) {
  return (
    <Widget title={T.tabMine} tight>
      <div>
        {m.rows.map((r) => (
          <div
            key={r.id}
            className="grid grid-cols-[--spacing(47.5)_--spacing(32.5)_minmax(0,1fr)_auto] items-baseline gap-3.5 border-t border-border py-2.5 first:border-t-0 max-story:grid-cols-[minmax(0,1fr)_auto]"
          >
            <span className="min-w-0 font-heavy">
              {r.name}
              <small className="block text-2xs font-medium text-fg-muted">{r.symbol}</small>
            </span>
            <span className={`text-xs font-strong ${healthTone[r.health.tone]}`}>
              {r.health.text}
            </span>
            <button type="button" className={noteLink} onClick={r.onOpen}>
              {r.line}
            </button>
            {r.soon ? (
              <span className="whitespace-nowrap rounded-sm bg-warning-bg px-1.75 py-0.5 text-2xs font-bold text-warning">
                {r.soon}
              </span>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
    </Widget>
  );
}

const dotTone = { pos: "bg-positive", neg: "bg-negative", "": "bg-fg-muted" } as const;
const relTone = { pos: "text-positive", neg: "text-negative" } as const;

export function NotesTab({ m }: { m: Tab<"notes"> }) {
  return (
    <Widget title={T.tabNotes} id="rsch-notes" count={m.count} tight>
      <fieldset
        aria-label={T.filters}
        className="m-0 mb-2 flex min-w-0 flex-wrap gap-1.5 border-0 p-0"
      >
        {m.filters.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={f.pressed}
            onClick={f.onPress}
            className="cursor-pointer rounded-full border border-border bg-surface-raised px-2.75 py-0.75 text-xs text-fg aria-pressed:border-fg aria-pressed:bg-fg aria-pressed:text-surface-raised"
          >
            {f.label}
          </button>
        ))}
      </fieldset>
      {m.empty && <div className="text-fg-muted">{T.noNotes}</div>}
      {m.items.map((n) => (
        <div key={n.id}>
          {n.dayHead && (
            <div className="mt-3 mb-0.5 text-2xs font-heavy uppercase tracking-section text-fg-muted">
              {n.dayHead}
            </div>
          )}
          <article
            data-note={n.id}
            id={`note-${n.id}`}
            className="grid grid-cols-[--spacing(2)_minmax(0,1fr)_auto] items-baseline gap-3 border-t border-border px-0.5 py-2"
          >
            <i
              aria-hidden="true"
              className={`block size-1.75 -translate-y-px rounded-full ${dotTone[n.dot]}`}
            />
            <div className="min-w-0">
              <button
                type="button"
                aria-expanded={n.open}
                onClick={n.onToggle}
                className="cursor-pointer border-0 bg-transparent p-0 text-left text-md-plus font-strong leading-row text-fg hover:text-accent"
              >
                {n.headline}
              </button>
              <div className="mt-0.5 text-xs text-fg-muted">
                {n.meta}
                {n.rel && (
                  <>
                    {" · "}
                    <span className={`font-strong ${relTone[n.rel.tone]}`}>{n.rel.text}</span>
                  </>
                )}
              </div>
              {n.full && (
                <div className="mt-2 grid max-w-note justify-items-start gap-1.5 text-sm">
                  {n.full.tech && <div className="font-strong text-fg-muted">{n.full.tech}</div>}
                  {n.full.paragraphs.map((t) => (
                    <p key={t} className="m-0">
                      {t}
                    </p>
                  ))}
                  {n.full.sources.length > 0 && (
                    <div className="flex flex-wrap gap-2 text-xs text-fg-muted">
                      {T.sources}:{" "}
                      {n.full.sources.map((s) =>
                        s.href ? (
                          <a
                            key={`${s.href}${s.text}`}
                            href={s.href}
                            target="_blank"
                            rel="noreferrer"
                            className="text-accent"
                          >
                            {s.text}
                          </a>
                        ) : (
                          <span key={s.text}>{s.text}</span>
                        ),
                      )}
                    </div>
                  )}
                  {n.full.onOpen && (
                    <Button variant="link" size="lg" onPress={n.full.onOpen}>
                      {T.openIn}
                    </Button>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              aria-label={n.dismissLabel}
              title={n.dismissLabel}
              disabled={n.busy}
              onClick={n.onDismiss}
              className="cursor-pointer border-0 bg-transparent px-1 py-0.5 text-xs text-fg-muted hover:text-fg"
            >
              ✕
            </button>
          </article>
        </div>
      ))}
      {m.more && (
        <Button variant="link" size="lg" className="mt-2.5" onPress={m.onMore}>
          {m.more}
        </Button>
      )}
    </Widget>
  );
}

export function CalendarTab({ m }: { m: Tab<"calendar"> }) {
  return (
    <Widget
      title={T.tabCalendar}
      tight
      footer={<span className="text-fg-muted">{T.calendarSources}</span>}
    >
      <div className="mb-1.5 text-md font-heavy">{m.say}</div>
      <AheadDays days={m.days} />
      {m.stale && <div className="mt-2 text-xs text-fg-muted">{T.calendarStale}</div>}
    </Widget>
  );
}

export function CandidatesTab({ m }: { m: Tab<"candidates"> }) {
  return (
    <Widget
      title={S.candidates}
      count={m.count}
      controls={<span className="text-xs text-fg-muted">{m.by}</span>}
      tight
    >
      {!m.cards.length ? (
        <div className="text-sm text-fg-muted">{S.noCandidates}</div>
      ) : (
        m.cards.map((c, i) => <CandidateCard key={c.id} {...c} className={i > 0 ? "mt-2.5" : ""} />)
      )}
    </Widget>
  );
}

const runDot = { pos: "bg-positive", info: "bg-info", neg: "bg-negative" } as const;

export function RunsTab({ m }: { m: Tab<"runs"> }) {
  return (
    <Widget
      title={S.runs}
      count={m.count}
      tight
      flush
      footer={
        <>
          <span className="flex-1" />
          <span>
            {S.routine} <b>{S.saturday}</b> · Claude Code
          </span>
        </>
      }
    >
      <table className={tableCls(true)}>
        <thead>
          <tr>
            <th className={thCls()}>{S.colDate}</th>
            <th className={thCls()}>{S.colStatus}</th>
            <th className={thCls()}>{S.colScope}</th>
            <th className={thCls(true)}>{S.colNotes}</th>
            <th className={thCls(true)} title={S.colSignalsTitle}>
              {S.colSignals}
            </th>
            <th className={thCls(true)}>{S.colTime}</th>
            <th className={thCls()}>{S.colStartedBy}</th>
          </tr>
        </thead>
        <tbody>
          {m.rows.map((r) => (
            <tr key={r.id}>
              <td className={`${tdCls()} tabular-nums`}>{r.date}</td>
              <td className={tdCls()}>
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs-plus text-fg">
                  <i
                    aria-hidden="true"
                    className={`inline-block size-2 flex-none rounded-full ${runDot[r.status.tone]}`}
                  />{" "}
                  {r.status.text}
                </span>
              </td>
              <td className={tdCls()}>{r.scope}</td>
              <td className={tdCls(true)}>{r.notes}</td>
              <td className={tdCls(true)}>{r.signals}</td>
              <td className={tdCls(true)}>{r.time}</td>
              <td className={tdCls()}>{r.by}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Widget>
  );
}

/** `.kvl` of Zakres i zasady. */
export function ScopeWidget({ s }: { s: Tab<"runs">["scope"] }) {
  const k = "text-fg-muted";
  return (
    <Widget title={S.scopeRules} tight>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.25 text-xs-plus">
        <span className={k}>{S.scope}</span>
        <span>
          <b>{s.line}</b>
          {s.rest}
        </span>
        <span className={k}>{S.sources}</span>
        <span>{S.sourcesList}</span>
        <span className={k}>{S.not}</span>
        <span>{S.notList}</span>
        <span className={k}>{S.privacy}</span>
        <span>{s.privacy}</span>
        <span className={k}>{S.workspace}</span>
        <span>
          <CommandCode wrap>{s.path}</CommandCode>
          {S.mcpOnly}
        </span>
        <span className={k}>{S.validity}</span>
        <span>{S.validityLine}</span>
      </div>
    </Widget>
  );
}

/** Old ScheduleHow (`.sched`): the local routine in the Claude app, in the profile's workspace folder. */
function ScheduleHow({ s }: { s: ScheduleModel }) {
  return (
    <div className="grid max-w-sched gap-1.25 rounded-control bg-chip px-3 py-2 text-xs-plus text-fg-muted">
      <div>
        <b className="font-strong text-fg">{s.menu}</b>
        {P.schedule}
        <CommandCode wrap surface="card">
          {s.path}
        </CommandCode>
        {P.prompt}
        <CommandCode surface="card">{s.routine.command}</CommandCode>
      </div>
      <div className="flex flex-wrap items-center justify-start gap-2">
        <Copy c={s.routine} />
        <Copy c={s.folder} />
        <Button variant="link" size="lg" onPress={s.onSettings}>
          {P.settingsLink}
        </Button>
      </div>
    </div>
  );
}

/** Old EmptyResearch (`.rsch-empty`): never ran, with the three steps (skill, first run, schedule). */
export function EmptyResearch({
  m,
  onSettings,
  onHow,
}: {
  m: EmptyModel;
  onSettings(): void;
  onHow(): void;
}) {
  const steps: SetupStepItem[] = m.steps.map((s) => ({
    key: s.key,
    status: s.status,
    title:
      s.title.kind === "text" ? (
        <span>{s.title.text}</span>
      ) : (
        <span>
          {s.title.label} <b>{s.title.skill}</b> {s.title.state}
        </span>
      ),
    hint:
      s.hint == null ? undefined : s.hint.kind === "text" ? (
        s.hint.text
      ) : (
        <>
          {s.hint.before} <code>{s.hint.code}</code>
          {s.hint.after}
        </>
      ),
    tag: s.tag ? <span className="text-xs font-regular text-fg-muted">{s.tag}</span> : undefined,
    actions:
      s.action == null ? undefined : s.action.kind === "settings" ? (
        <Button variant={s.action.primary ? "primary" : "secondary"} onPress={onSettings}>
          {S.settings}
        </Button>
      ) : s.action.kind === "copy" ? (
        <Copy c={s.action.copy} />
      ) : (
        <Button expanded={s.action.open} onPress={onHow}>
          {S.howToSchedule}
        </Button>
      ),
    body:
      s.key === "schedule" && m.schedule ? (
        <div className="my-1.5">
          <ScheduleHow s={m.schedule} />
        </div>
      ) : undefined,
  }));
  return (
    <Widget title={S.research} tags={<Tag>{S.neverRan}</Tag>} tight>
      <div className="text-md font-strong">{S.lead}</div>
      <div className="mt-0.5 mb-1.5 text-xs-plus text-fg-muted">{S.noRecommendations}</div>
      <SetupSteps steps={steps} />
    </Widget>
  );
}
