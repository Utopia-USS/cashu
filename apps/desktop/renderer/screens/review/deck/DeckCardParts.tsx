// The review deck's card pieces (ab24ab6 v2/ReviewDeck.tsx `cardFor` bodies, CmpRow, SummaryCard) as pure
// components over reviewDeckModel.ts data; class constants carry the effective values of reviewDeck.css plus the
// global-class quirks the old cascade gave them (old-frontend-map.md section C).
import { S } from "@cashu/i18n/investments/v2/ReviewDeck.strings";
import { Pill, Skeleton } from "@cashu/ui";
import type { Tone } from "@cashu/ui-logic/investments/v2/reviewDeckLogic";
import type {
  CardBody,
  CardModel,
  CmpRowModel,
  DecideItemModel,
  IdeaModel,
  More,
  Run,
  Signed,
  SummaryModel,
} from "./reviewDeckModel.js";

const signedText: Record<Signed, string> = { "": "", pos: "text-positive", neg: "text-negative" };
const pillTone = { pos: "positive", neg: "negative", warn: "warning", info: "info" } as const;

// `.rd .eyebrow`
export const eyebrow = "text-2xs font-heavy tracking-eyebrow uppercase text-fg-muted";
// `.rd .lnk` (keeps the global `.lnk` underline): 13px 600 accent, padding 4px 0.
const linkBase =
  "cursor-pointer border-0 bg-transparent px-0 py-1 text-sm underline underline-offset-2";
export const link = `${linkBase} font-strong text-accent`;
// `.rd-cf button.lnk.note` (+ `.has`; research.css `.note` adds display grid, gap 4px).
export const noteLink = (has: boolean) =>
  `${linkBase} ml-auto grid gap-1 ${has ? "font-strong text-net" : "font-medium text-fg-muted"}`;
// `.rd-ch`, `.rd-card h2`, `.rd-cb`
const head = "flex items-center gap-2 px-5 pt-4.5";
const h2 =
  "mx-5 mt-2 mb-0 text-balance text-3xl font-bold leading-tight tracking-snug max-phone:text-xl";
export const body =
  "flex min-h-0 flex-1 flex-col gap-3.5 overflow-x-hidden overflow-y-auto px-5 pt-3.5 pb-2 text-md leading-widget";
// `.rd-hint`, `.rd-cb h4`
const hint = "text-xs text-fg-muted";
const h4 = "m-0 mb-1.5 text-2xs font-heavy uppercase tracking-eyebrow text-fg-muted";
// `.rd-note textarea, .rd-cb textarea` (global textarea focus: accent border, no outline).
export const textarea =
  "min-h-16 w-full resize-y rounded-md border border-border bg-subtle px-2.5 py-2 text-sm text-fg focus:border-accent focus:outline-none";
// `.rd .tag` (+ `.mine`; keeps the global `.tag` border, line height and nowrap).
const tag = (mine: boolean) =>
  `mr-1 inline-block whitespace-nowrap rounded-sm border border-border px-1.75 text-2xs font-strong leading-normal ${mine ? "bg-info-bg text-info" : "bg-chip text-chip-fg"}`;

/** Bold runs and plain text in order (`<b>headline.</b> why`). */
function Runs({ runs }: { runs: Run[] }) {
  return (
    <>
      {runs.map((r, k) =>
        r.b ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed run order per text
          <b key={k} className={signedText[r.tone ?? ""]}>
            {r.text}
          </b>
        ) : (
          r.text
        ),
      )}
    </>
  );
}

/** `.rd-ch` (eyebrow + pill) and the `<h2>`. */
export function CardHead({ card }: { card: CardModel }) {
  return (
    <>
      <div className={head}>
        <span className={eyebrow}>{card.eyebrow}</span>
        <Pill tone={pillTone[card.tone]} size="lg" className="ml-auto">
          {card.pill}
        </Pill>
      </div>
      <h2 className={h2}>{card.title}</h2>
    </>
  );
}

function CmpRow({ row }: { row: CmpRowModel }) {
  const fill =
    row.fill === "bench" ? "bg-bench" : row.fill === "pos" ? "bg-positive" : "bg-negative";
  return (
    <div className="grid grid-cols-[--spacing(24)_minmax(auto,1fr)_--spacing(16)] items-center gap-2.5 text-sm max-phone:grid-cols-[--spacing(20)_minmax(auto,1fr)_--spacing(14)]">
      <span className={row.bench ? "text-fg-muted" : ""}>{row.label}</span>
      <div className="relative h-2.5 overflow-hidden rounded-xs bg-subtle">
        <i
          className={`absolute inset-y-0 rounded-xs ${row.up ? "left-0" : "right-0"} ${fill}`}
          style={{ width: `${row.width}%` }}
        />
      </div>
      <span className={`text-right font-strong tabular-nums ${row.bench ? "text-fg-muted" : ""}`}>
        {row.value}
      </span>
    </div>
  );
}

// `.rd-dec .it` (+ group left border, `.done`), `.k` tones, `.acts button` looks.
const groupBorder = {
  risk: "border-l-3 border-l-negative",
  chance: "border-l-3 border-l-positive",
  plan: "border-l-3 border-l-info",
  fix: "border-l-3 border-l-warning",
  mixed: "",
} as const;
const groupText = {
  risk: "text-negative",
  chance: "text-positive",
  plan: "text-info",
  fix: "text-warning",
  mixed: "text-fg-muted",
} as const;
const kTone: Record<Tone, string> = {
  neg: "text-negative",
  pos: "text-positive",
  info: "text-info",
  warn: "text-info",
};
const item = (done: boolean, border = "") =>
  `grid gap-1.5 rounded-lg border border-border p-3 ${border} ${done ? "bg-subtle" : ""}`;
const k = "text-2xs font-heavy uppercase tracking-label";
const st = "ml-auto text-xs text-fg-muted";
const itemTitle = "text-md font-heavy";
// `.rd-dec .w` also matches the global widget `.w`: it keeps the card shadow, flex column and min-width 0.
const why = "flex min-w-0 flex-col text-sm shadow-card";
// `.rd-dec .acts` also matches the global `.acts`: the buttons sit at the right edge.
const acts = "mt-0.5 flex flex-wrap justify-end gap-1.5";
const actLook = {
  "": "border-border bg-surface-raised text-fg",
  pri: "border-fg bg-fg text-surface-raised",
  on: "border-transparent bg-info-bg text-info",
};
const act = (look: keyof typeof actLook, disabled: boolean) =>
  `cursor-pointer rounded-control border px-2.5 py-1.25 text-xs font-strong leading-control font-control disabled:cursor-default ${actLook[look]} ${disabled && look !== "on" ? "opacity-45" : ""}`;

function DecideRow({
  d,
  onDecide,
}: {
  d: DecideItemModel;
  onDecide(key: string, action: string, label: string): void;
}) {
  return (
    <div className={item(!!d.choice, groupBorder[d.group])}>
      <div className="flex items-center gap-2">
        <span className={`${k} ${kTone[d.tone]}`}>{d.tag}</span>
        {d.choice && <span className={st}>✓ {d.choice}</span>}
      </div>
      <div className={itemTitle}>{d.title}</div>
      <div className={why}>{d.why}</div>
      {d.context && <div className="text-xs text-fg-muted">{d.context}</div>}
      <div className={acts}>
        {d.actions.map((a) => (
          <button
            key={a.action}
            type="button"
            className={act(a.look, a.disabled)}
            disabled={a.disabled}
            onClick={() => onDecide(d.key, a.action, a.label)}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function IdeaRow({
  n,
  onWatch,
  onDismiss,
}: {
  n: IdeaModel;
  onWatch(id: number): void;
  onDismiss(id: number): void;
}) {
  const disabled = !!n.choice || n.busy;
  return (
    <div className={item(!!n.choice)}>
      <div className="flex items-center gap-2">
        <span className={`${k} text-positive`}>{n.tag}</span>
        {n.choice && <span className={st}>✓ {n.choice}</span>}
      </div>
      <div className={itemTitle}>
        {n.name}
        {n.sym ? <span className="text-fg-muted"> · {n.sym}</span> : null}
      </div>
      <div className={why}>{n.why}</div>
      <div className={acts}>
        <button
          type="button"
          className={act(n.choice ? "" : "pri", disabled)}
          disabled={disabled}
          onClick={() => onWatch(n.id)}
        >
          {S.watch}
        </button>
        <button
          type="button"
          className={act("", disabled)}
          disabled={disabled}
          onClick={() => onDismiss(n.id)}
        >
          {S.notInterested}
        </button>
      </div>
    </div>
  );
}

export interface BodyActions {
  onDecide(key: string, action: string, label: string): void;
  onWatch(id: number): void;
  onDismiss(id: number): void;
}

const mover = "flex justify-between gap-2 rounded-md bg-subtle px-2.5 py-2 text-sm";
const timeline = "grid gap-3";
const tlRow = "grid grid-cols-[--spacing(16)_minmax(auto,1fr)] gap-2.5";
const tlDate = "pt-0.5 text-xs text-fg-muted";
const tlDay = "block text-md text-fg";

/** The card's `.rd-cb` content (old `cardFor(...).body`). */
export function CardBodyView({ body: b, actions }: { body: CardBody; actions: BodyActions }) {
  switch (b.kind) {
    case "world":
      return (
        <>
          <div className="flex flex-wrap items-baseline gap-2.5 tabular-nums">
            <span
              className={`text-6xl font-black leading-none tracking-heading max-phone:text-5xl ${signedText[b.valueTone]}`}
            >
              {b.value}
            </span>
            {b.money && (
              <span className={`text-base font-strong ${signedText[b.money.tone]}`}>
                {b.money.text}
              </span>
            )}
            <span className="text-fg-muted">{b.since}</span>
          </div>
          <div className="grid gap-2">
            {b.rows.map((r) => (
              <CmpRow key={r.label} row={r} />
            ))}
            {b.stale && (
              <div className="text-fg-muted" title={b.stale.title}>
                {b.stale.label}
              </div>
            )}
          </div>
          <div className="rounded-md bg-subtle px-3 py-2.5 text-sm text-fg-muted">
            {b.drawdown && (
              <>
                {S.fromHigh} <b className="font-strong text-fg">{b.drawdown.now}</b>
                {b.drawdown.max != null && (
                  <>
                    {S.maxDrawdownYear}
                    <b className="font-strong text-fg">{b.drawdown.max}</b>
                  </>
                )}
                .{" "}
              </>
            )}
            {b.sigma}
          </div>
        </>
      );
    case "sectors":
      return (
        <>
          <div className="grid gap-2.25">
            {b.rows.map((r) => (
              <div
                key={r.key}
                className="grid grid-cols-[minmax(0,1.1fr)_minmax(auto,1.3fr)_--spacing(15)] items-center gap-2.5 text-sm"
              >
                <span className="min-w-0">
                  {r.label}
                  <small className="block text-2xs text-fg-muted">{r.small}</small>
                </span>
                <span className="relative h-3 before:absolute before:-top-0.75 before:-bottom-0.75 before:left-1/2 before:w-px before:bg-border before:content-['']">
                  <i
                    className={`absolute inset-y-0 rounded-3xs ${r.tone === "pos" ? "left-1/2" : "right-1/2"} ${r.currency ? "bg-bench" : r.tone === "pos" ? "bg-positive" : "bg-negative"}`}
                    style={{ width: `${r.width}%` }}
                  />
                </span>
                <span className={`text-right font-strong tabular-nums ${signedText[r.tone]}`}>
                  {r.pp}
                </span>
              </div>
            ))}
          </div>
          <div className={hint}>{S.ppHint}</div>
        </>
      );
    case "positions": {
      const col = (title: string, rows: typeof b.down) => (
        <div className="min-w-0">
          <h4 className={h4}>{title}</h4>
          <div className="grid gap-1.5">
            {rows.length ? (
              rows.map((m) => (
                <div key={m.id} className={mover}>
                  <span className="min-w-0 truncate">{m.label}</span>
                  <b className={`flex-none font-heavy tabular-nums ${signedText[m.tone]}`}>
                    {m.ret}
                  </b>
                </div>
              ))
            ) : (
              <div className="text-fg-muted">{S.none}</div>
            )}
          </div>
        </div>
      );
      return (
        <div className="grid grid-cols-2 gap-3.5 max-phone:grid-cols-1">
          {col(S.down, b.down)}
          {col(S.up, b.up)}
        </div>
      );
    }
    case "events":
      return (
        <div className={timeline}>
          {b.rows.map((r) => (
            <div key={r.key} className={tlRow}>
              <div className={tlDate}>
                <b className={tlDay}>{r.date}</b>
              </div>
              <div>
                <div className="text-md font-strong">{r.title}</div>
                <div className="mt-0.5 text-xs text-fg-muted">{r.info}</div>
              </div>
            </div>
          ))}
        </div>
      );
    case "decide":
      return (
        <>
          <div className="grid gap-2.5">
            {b.groups.map((g) => [
              <div
                key={`g:${g.group}`}
                className={`mt-1 flex items-center gap-2 text-2xs font-bold uppercase tracking-eyebrow first:mt-0 after:h-px after:flex-1 after:bg-border after:content-[''] ${groupText[g.group]}`}
              >
                {g.label} <span className="font-medium">{g.count}</span>
              </div>,
              ...g.items.map((d) => <DecideRow key={d.key} d={d} onDecide={actions.onDecide} />),
            ])}
          </div>
          <div className={hint}>{b.hint}</div>
        </>
      );
    case "ideas":
      return (
        <div className="grid gap-2.5">
          {b.items.map((n) => (
            <IdeaRow key={n.id} n={n} onWatch={actions.onWatch} onDismiss={actions.onDismiss} />
          ))}
        </div>
      );
    case "calendar":
      if (b.loading) return <Skeleton height={160} />;
      return (
        <>
          <div className={timeline}>
            {b.rows.map((r) => (
              <div key={r.key} className={tlRow}>
                <div className={tlDate}>
                  <b className={tlDay}>{r.date}</b>
                  {r.time}
                </div>
                <div>
                  <div className="text-md font-strong">{r.title}</div>
                  <div className="mt-0.5 text-xs text-fg-muted">
                    {r.tags.map((x) => (
                      <span key={x.text} className={tag(x.mine)}>
                        {x.text}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {b.hint && <div className={hint}>{b.hint}</div>}
          <div className={hint}>{S.calendarSources}</div>
        </>
      );
  }
}

/** "Czytaj więcej": `.rd-cb.more` with the lead and the bullets, each with "pełna notatka →". */
export function MoreBody({ more, onOpenNote }: { more: More; onOpenNote(noteId: number): void }) {
  return (
    <div className={body}>
      {more.lead && <b>{more.lead}</b>}
      <ul className="m-0 grid list-disc gap-2.5 pl-4.5">
        {more.items.map((it, n) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the bullets of one card in a fixed order
          <li key={n}>
            <Runs runs={it.text} />
            {it.noteId != null && (
              <>
                {" "}
                <button
                  type="button"
                  className={link}
                  onClick={() => it.noteId != null && onOpenNote(it.noteId)}
                >
                  {S.fullNote}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const stat = "rounded-md bg-subtle p-2.5";
const line = "rounded-md bg-subtle px-2.5 py-2 text-sm";
// `.rd-close`: the text-coloured full-width button.
const close =
  "cursor-pointer rounded-widget border-0 bg-fg p-3 text-base font-heavy leading-control font-control text-surface-raised disabled:cursor-default disabled:opacity-60";

/** The last card (old SummaryCard body): stats, agenda, decisions, skipped, the closing note and the close. */
export function SummaryBody({
  summary: s,
  closing,
  busy,
  onClosing,
  onFinish,
}: {
  summary: SummaryModel;
  closing: string;
  busy: boolean;
  onClosing(value: string): void;
  onFinish(): void;
}) {
  return (
    <div className={body}>
      <div className="grid grid-cols-3 gap-2">
        {s.stats.map((x) => (
          <div key={x.label} className={stat}>
            <b className="block text-2xl">{x.value}</b>
            <span className="text-xs text-fg-muted">{x.label}</span>
          </div>
        ))}
      </div>
      {s.agenda.length > 0 && (
        <>
          <h4 className={h4}>{S.discussWithAgent}</h4>
          {s.agenda.map((a) => (
            <div key={a.id} className={line}>
              <b>{a.title}</b>
              {a.note ? (
                <>
                  {" "}
                  · <q className="text-fg-muted [quotes:'„'_'”']">{a.note}</q>
                </>
              ) : (
                S.noNote
              )}
            </div>
          ))}
        </>
      )}
      {s.decisions.length > 0 && (
        <>
          <h4 className={h4}>{S.decisions}</h4>
          {s.decisions.map((d) => (
            <div key={d.key} className={line}>
              {d.title} · <b>{d.choice}</b>
            </div>
          ))}
        </>
      )}
      {s.skipped && <div className={hint}>{s.skipped}</div>}
      <h4 className={h4}>{S.reviewNote}</h4>
      <textarea
        id="inv-review-note"
        className={textarea}
        aria-label={S.reviewNote}
        placeholder={S.reviewNotePlaceholder}
        value={closing}
        onChange={(e) => onClosing(e.target.value)}
      />
      <button type="button" className={close} onClick={onFinish} disabled={busy}>
        {S.closeReview}
      </button>
      <div className={hint}>{S.agentHint}</div>
    </div>
  );
}
