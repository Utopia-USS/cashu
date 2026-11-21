// The ported signals dialog (ab24ab6 v2/Signals.tsx SignalsDialog + SignalItem + GroupActs + DecisionForm,
// v2/Decide.tsx PositionDecisionDialog; index.css `.sdlg`, `.scope2`, `.polh`, `.sig`, `.sub-sig`, `.decide`,
// `.ddlg`): the scope columns (Portfel 2/3, Obserwowane 1/3), one subject per row with its fact, thesis and
// actions or the inline decision form, the footer, the position decision dialog on top. Pure: every text and
// callback comes from signalsDialogModel.ts through the screen hook.
import {
  Button,
  Dialog,
  HoverCard,
  InstCardBody,
  PolDot,
  Seg,
  Tag,
  useHoverCard,
  useTouch,
} from "@cashu/ui";
import { useEffect, useId, useRef } from "react";
import { inputCls, selectCls, textareaCls } from "./fields.js";
import type {
  DecisionFormProps,
  GroupProps,
  ItemProps,
  MetricProps,
  PositionDialogProps,
  Press,
  SignalFilter,
  ThesisProps,
  TitleProps,
} from "./signalsDialogModel.js";
import type { Age, FactParts } from "./signalsModel.js";

interface SignalsColumn {
  label: string;
  count: number;
  groups: GroupProps[];
  none: string;
}

export interface SignalsDialogProps {
  label: string;
  title: string;
  count: number | null;
  decided: string | null;
  filter: {
    label: string;
    items: [string, SignalFilter][];
    value: SignalFilter;
    onChange(v: SignalFilter): void;
  };
  hint: string;
  /** No open signal at all. */
  empty: string | null;
  /** One column (no watchlist) or Portfel + Obserwowane. */
  columns: SignalsColumn[];
  /** The foot's left facts (`text <b>bold</b>tail`). */
  foot: { text: string; bold: string | null; tail: string }[];
  journal: Press;
  onClose(): void;
}

const btn = (p: Press, key?: string) => (
  <Button
    key={key ?? p.label}
    size="sm"
    variant={p.primary ? "primary" : "secondary"}
    disabled={p.disabled}
    title={p.title}
    onPress={p.onPress}
  >
    {p.label}
  </Button>
);

const Fact = ({ f }: { f: FactParts }) => (
  <>
    {f.pre}
    {f.bold && <b className="font-strong text-fg tabular-nums">{f.bold}</b>}
    {f.post}
  </>
);

const AgeText = ({ a, plain }: { a: Age; plain?: boolean }) =>
  a.text ? (
    <span
      className={`text-xs ${plain ? "ml-1" : "font-medium"} ${a.warn ? "text-warning" : "text-fg-muted"}`}
      title={a.title}
    >
      {a.text}
    </span>
  ) : null;

/** Old InstLabel `inline` (`.il.inl`): the ticker button and its symbol; hovering (350 ms) or keyboard focus of the
 * ticker opens the instrument card, without hover the label carries the one-line title. */
function InlineLabel({ t }: { t: Extract<TitleProps, { kind: "inst" }> }) {
  const id = useId();
  const touch = useTouch();
  const hover = useHoverCard(!!t.card && !touch);
  return (
    <span title={touch ? t.card?.touchTitle : undefined} {...hover.handlers}>
      <button
        type="button"
        onClick={t.onOpen}
        aria-describedby={hover.anchor ? id : undefined}
        className="cursor-pointer border-0 bg-transparent p-0 text-left hover:text-accent"
      >
        {t.ticker}
      </button>
      {t.sym && <span className="ml-1.25 text-xs font-medium text-fg-muted">{t.sym}</span>}
      {hover.anchor && t.card && (
        <HoverCard anchor={hover.anchor} id={id}>
          <InstCardBody {...t.card.card} />
        </HoverCard>
      )}
    </span>
  );
}

function Title({ t, quiet }: { t: TitleProps; quiet: boolean }) {
  return (
    <div
      className={`flex flex-wrap items-baseline gap-1.5 text-sm-plus ${quiet ? "font-medium text-fg-muted" : "font-strong"}`}
    >
      {t.kind === "inst" ? (
        <>
          <span className="font-heavy">
            <InlineLabel t={t} />
          </span>
          {t.name && <span className="text-xs-plus font-medium text-fg-muted">{t.name}</span>}
        </>
      ) : (
        <>
          <span>{t.title}</span>
          {t.sym && <span className="text-xs font-medium text-fg-muted">{t.sym}</span>}
        </>
      )}
      {t.extra && <span className="text-xs-plus font-medium text-fg-muted">{t.extra}</span>}
      <AgeText a={t.age} />
    </div>
  );
}

const Thesis = ({ t, className = "mt-1 text-xs" }: { t: ThesisProps; className?: string }) => (
  <div className={`border-l-2 border-border pl-2 leading-cozy text-fg-muted ${className}`}>
    <b className="font-strong text-fg">{t.head}</b> {t.text}
  </div>
);

function Metric({ m }: { m: MetricProps }) {
  if (m.kind === "fact") return <Fact f={m.fact} />;
  if (m.kind === "snoozed")
    return (
      <>
        <Tag tone="positive" solid>
          {m.tag}
        </Tag>
        {m.fact && (
          <>
            {" · "}
            <Fact f={m.fact} />
          </>
        )}
      </>
    );
  return (
    <>
      <Tag tone="positive" solid>
        {m.tag}
      </Tag>
      {m.bold && (
        <>
          {" · "}
          {m.bold}
        </>
      )}
      {m.tail}
      {m.undo && (
        <>
          {" · "}
          <Button variant="link" size="sm" onPress={m.undo.onPress}>
            {m.undo.label}
          </Button>
        </>
      )}
    </>
  );
}

/** Old DecisionForm (`.decide`): Esc collapses it; the selected action takes the focus when it opens. */
function DecisionForm({ f, inSig }: { f: DecisionFormProps; inSig: boolean }) {
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    requestAnimationFrame(() =>
      ref.current?.querySelector<HTMLElement>("button[aria-pressed=true]")?.focus(),
    );
  }, []);
  const label = "text-2xs-plus text-fg-muted";
  return (
    <form
      ref={ref}
      onSubmit={(e) => e.preventDefault()}
      data-esc-local=""
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          f.collapse.onPress();
        }
      }}
      className={`grid gap-2 rounded-md bg-chip px-3 py-2.5 ${inSig ? "mt-2" : "mt-0.5"}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs-plus">
        <span className={label}>{f.seg.label}</span>
        <Seg
          label={f.seg.label}
          items={f.seg.items}
          value={f.seg.value}
          onChange={f.seg.onChange}
          className={inSig ? "bg-surface-raised" : ""}
        />
      </div>
      {f.research && (
        <div className="text-xs-plus text-fg-muted">
          {f.research.text}
          {f.research.link && (
            <>
              {" · "}
              <Button variant="link" size="lg" onPress={f.research.link.onPress}>
                {f.research.link.label}
              </Button>
            </>
          )}
        </div>
      )}
      {f.trade && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs-plus">
            <label htmlFor={f.trade.quantity.id} className={label}>
              {f.trade.quantity.label}
            </label>
            <input
              id={f.trade.quantity.id}
              inputMode="decimal"
              value={f.trade.quantity.value}
              onChange={(e) => f.trade?.quantity.onChange(e.target.value)}
              className={`${inSig ? "w-21" : "w-22.5"} ${inputCls({ num: true, card: inSig })}`}
            />
            <label htmlFor={f.trade.price.id} className={label}>
              {f.trade.price.label}
            </label>
            <input
              id={f.trade.price.id}
              inputMode="decimal"
              value={f.trade.price.value}
              onChange={(e) => f.trade?.price.onChange(e.target.value)}
              className={`${inSig ? "w-21" : "w-22.5"} ${inputCls({ num: true, card: inSig })}`}
            />
            <label htmlFor={f.trade.account.id} className={label}>
              {f.trade.account.label}
            </label>
            <select
              id={f.trade.account.id}
              value={f.trade.account.value}
              onChange={(e) => f.trade?.account.onChange(e.target.value)}
              className={selectCls({ card: inSig })}
            >
              {f.trade.account.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {f.effect && <div className="text-xs-plus text-fg-muted">{f.effect}</div>}
          {f.warn && <div className="text-xs-plus text-warning">{f.warn}</div>}
        </>
      )}
      <textarea
        rows={2}
        placeholder={f.reason.placeholder}
        value={f.reason.value}
        onChange={(e) => f.reason.onChange(e.target.value)}
        aria-label={f.reason.label}
        className={textareaCls({ card: inSig })}
      />
      <div className="flex flex-wrap items-center gap-2 text-xs-plus">
        <Button variant="primary" disabled={f.save.disabled} onPress={f.save.onPress}>
          {f.save.label}
        </Button>
        {f.ack && (
          <Button
            disabled={f.ack.disabled}
            onPress={f.ack.onPress}
            className={inSig ? "bg-surface-raised!" : ""}
          >
            {f.ack.label}
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="link" size="lg" onPress={f.collapse.onPress}>
          {f.collapse.label}
        </Button>
      </div>
      {f.noOrders && <div className="text-xs-plus text-fg-muted">{f.noOrders}</div>}
    </form>
  );
}

function Actions({ actions, note }: { actions: Press[] | null; note: Press | null }) {
  if (actions === null && note === null) return null;
  return (
    <div data-act="" className="mt-1 flex flex-wrap items-center gap-1">
      {actions?.map((p) => btn(p))}
      {note && (
        <Button variant="link" size="sm" onPress={note.onPress}>
          {note.label}
        </Button>
      )}
    </div>
  );
}

const flashCls = "rounded-sm animate-sig-flash motion-reduce:animate-none motion-reduce:bg-info-bg";

function Item({ it }: { it: ItemProps }) {
  if (it.sub)
    return (
      <div
        data-signal={it.id}
        className={`grid grid-cols-[--spacing(2.5)_minmax(0,1fr)] items-start gap-x-2.5 pt-1.5 pb-0.5 [&+&]:mt-1 [&+&]:border-t [&+&]:border-dashed [&+&]:border-border ${it.flash ? flashCls : ""}`}
      >
        <PolDot polarity={it.polarity} quiet={it.quiet} size="sm" className="mt-1.5" />
        <div>
          <div className="text-xs-plus text-fg-muted" title={it.long}>
            <Metric m={it.metric} /> {it.age && <AgeText a={it.age} />}
          </div>
          <Actions actions={it.actions} note={it.note} />
        </div>
      </div>
    );
  return (
    <div
      data-signal={it.id}
      className={`${sigCls} ${it.cursor ? curCls : ""} ${it.flash ? flashCls : ""}`}
    >
      <PolDot polarity={it.polarity} quiet={it.quiet} className="mt-1.5" />
      <div>
        {it.title && <Title t={it.title} quiet={it.quiet} />}
        <div className="mt-px text-xs-plus text-fg-muted" title={it.long}>
          <Metric m={it.metric} />
        </div>
        {it.thesis && <Thesis t={it.thesis} />}
        {it.form ? (
          <DecisionForm f={it.form} inSig />
        ) : (
          <Actions actions={it.actions} note={it.note} />
        )}
      </div>
    </div>
  );
}

const sigCls =
  "grid grid-cols-[--spacing(2.5)_minmax(0,1fr)_auto] items-start gap-x-2.5 border-b border-border py-2.25 last:border-b-0 last:pb-0.5";
const curCls = "-ml-1.5 pl-1.5 shadow-[inset_--spacing(0.75)_0_0_var(--color-accent)]";

function Group({ g }: { g: GroupProps }) {
  if (g.kind === "single") return <Item it={g.item} />;
  return (
    <div data-group={g.key} className={sigCls}>
      <PolDot state={g.state} title={g.stateLabel} quiet={g.quiet} className="mt-1.5" />
      <div>
        <Title t={g.title} quiet={g.quiet} />
        {g.thesis && <Thesis t={g.thesis} />}
        {g.items.map((it) => (
          <Item key={it.id} it={it} />
        ))}
        {g.acts && (
          <div className="mt-1.5">
            {g.acts.form ? (
              <DecisionForm f={g.acts.form} inSig />
            ) : (
              <Actions actions={g.acts.actions} note={null} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Column({ c, className = "" }: { c: SignalsColumn; className?: string }) {
  return (
    <div className={className}>
      <div className="mb-1 flex items-center gap-2 text-xs font-strong">
        {c.label} <span className="font-medium text-fg-muted">{c.count}</span>
      </div>
      {c.groups.length ? (
        c.groups.map((g) => <Group key={g.key} g={g} />)
      ) : (
        <div className="py-2 text-xs-plus text-fg-muted">{c.none}</div>
      )}
    </div>
  );
}

/** Old PositionDecisionDialog (`.ddlg`): the open signals as context, the thesis line, the decision form. */
export function PositionDecisionView({ p }: { p: PositionDialogProps }) {
  return (
    <Dialog
      size="narrow"
      label={p.label}
      onClose={p.onClose}
      title={p.title}
      head={
        <>
          {"·"}
          <span className="font-heavy">{p.ticker}</span>
          {p.name && <span className="text-xs-plus text-fg-muted">{p.name}</span>}
        </>
      }
    >
      <div className="grid gap-1">
        <div className="text-2xs font-strong uppercase tracking-eyebrow text-fg-muted">
          {p.kick}
        </div>
        {p.lines.map((l) => (
          <div key={l.id} className="flex items-baseline gap-2 text-sm" title={l.long}>
            <PolDot polarity={l.polarity} className="relative -top-px" />
            <span>
              <Fact f={l.fact} /> <AgeText a={l.age} plain />
            </span>
          </div>
        ))}
        {p.more && <div className="text-xs text-fg-muted">{p.more}</div>}
      </div>
      {p.thesis && <Thesis t={p.thesis} className="mt-0.5 text-xs-plus" />}
      <DecisionForm f={p.form} inSig={false} />
    </Dialog>
  );
}

export function SignalsDialogView(p: SignalsDialogProps) {
  const [first, second] = p.columns;
  return (
    <Dialog
      label={p.label}
      title={p.title}
      onClose={p.onClose}
      focus="panel"
      head={
        <>
          {p.count != null && <Tag>{p.count}</Tag>}
          {p.decided && (
            <Tag tone="positive" solid>
              {p.decided}
            </Tag>
          )}
          <Seg
            quiet
            label={p.filter.label}
            items={p.filter.items}
            value={p.filter.value}
            onChange={p.filter.onChange}
            className="ml-1.5"
          />
        </>
      }
      hint={p.hint}
      footer={
        <>
          {p.foot.map((f) => (
            <span key={f.text}>
              {f.text}
              {f.bold != null && (
                <>
                  {" "}
                  <b>{f.bold}</b>
                </>
              )}
              {f.tail}
            </span>
          ))}
          <span className="flex-1" />
          <Button variant="link" size="sm" onPress={p.journal.onPress}>
            {p.journal.label}
          </Button>
        </>
      }
    >
      {p.empty ? (
        <div className="px-5 py-7 text-center text-md text-fg-muted">{p.empty}</div>
      ) : second && first ? (
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] items-start gap-x-6 max-narrow:grid-cols-[minmax(0,1fr)]">
          <Column c={first} />
          <Column
            c={second}
            className="border-l border-border pl-6 max-narrow:mt-2 max-narrow:border-t max-narrow:border-l-0 max-narrow:pt-2 max-narrow:pl-0"
          />
        </div>
      ) : (
        first && <Column c={first} />
      )}
    </Dialog>
  );
}
