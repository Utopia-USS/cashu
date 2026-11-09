// The asset detail of the Python app (ab24ab6 v2/AssetPage.tsx AssetDetail + WatchNote + OpenSignalRow +
// GroupAck): `.g2.asset` = the header card, the price chart, the left stack (Dlaczego obserwuję, Teza,
// Rekomendacja) and the right stack (Alerty, Research), then Sygnały i decyzje. The same body renders in the
// drawer and as a page. Pure: the model (assetModel.ts) carries every text; the slots carry other features' parts.
import { C } from "@cashu/i18n/core/common.strings";
import { S } from "@cashu/i18n/investments/v2/AssetPage.strings";
import { S as SG } from "@cashu/i18n/investments/v2/SegmentSelect.strings";
import {
  Button,
  ChartLegend,
  Fact,
  HintChip,
  InstLabel,
  LineChart,
  PlanGlyph,
  PolDot,
  Seg,
  Select,
  Spinner,
  TextField,
  tintInk,
  Widget,
} from "@cashu/ui";
import type { ReactNode } from "react";
import type { FactParts } from "../../signals/signalsModel.js";
import type { AssetMode, AssetModel, OpenSignalRowModel } from "./assetModel.js";

export interface AssetDetailUi {
  setMonths(months: number): void;
  lotsOpen: boolean;
  toggleLots(): void;
  /** Header actions (old AssetDetail props). */
  /** Returns the toggle's promise (the button's spinner). */
  onToggleWatch(): unknown;
  watchBusy: boolean;
  onAddTxn(): void;
  onTxns(): void;
  onDecide(): void;
  onThesis(): void;
  onAlerts(): void;
  onJournal(): void;
  /** The topic select of the meta line. */
  segment: { value: string; busy: boolean; title?: string; onChange(value: string): void } | null;
  /** `notatka` of a research signal / a reason line of the recommendation. */
  onOpenNote?(noteId: number | null, segment: string | null): void;
  /** `potwierdź` of one open signal, `Potwierdź` of all of them. */
  onAck(id: number): unknown;
  ackBusy(id: number): boolean;
  onAckAll(): unknown;
  ackAllBusy: boolean;
  /** Dlaczego obserwuję: the draft while editing (null = reading). */
  note: {
    draft: string | null;
    saved: string | null;
    busy: boolean;
    error: string | null;
    onEdit(): void;
    onDraft(text: string): void;
    onCancel(): void;
    onSave(): unknown;
  };
}

export interface AssetDetailSlots {
  /** The thesis health pill after the entry type (old ASSET_SLOTS.ThesisTags). */
  thesisTags?: ReactNode;
  /** The research widget of the right column (old ASSET_SLOTS.Research), null when not shown. */
  research?: ReactNode;
  /** The live alerts as compact rows (A2's AlertRow), shown when the instrument has any. */
  alertRows?: ReactNode;
  /** The position decision dialog while open. */
  decision?: ReactNode;
}

const pos = "text-positive";
const neg = "text-negative";
const tone = (t: "positive" | "negative") => (t === "positive" ? pos : neg);
const muted13 = "text-sm text-fg-muted";
const lnk =
  "cursor-pointer border-0 bg-transparent p-0 text-xs-plus text-accent underline underline-offset-2";
const sep = "w-px self-stretch bg-border max-narrow:hidden";

/** The fact line `{pre} <b>{bold}</b>{post}` (Signals.tsx Fact1). */
function Fact1({ f }: { f: FactParts }) {
  return (
    <>
      {f.pre}
      {f.bold && <b className="font-strong text-fg tabular-nums">{f.bold}</b>}
      {f.post}
    </>
  );
}

function OpenSignalRow({
  s,
  grouped,
  ui,
}: {
  s: OpenSignalRowModel;
  grouped: boolean;
  ui: AssetDetailUi;
}) {
  return (
    <div
      data-signal={s.id}
      className="group/orow grid grid-cols-[--spacing(2.5)_minmax(0,1fr)_auto] items-start gap-x-2.5 border-b border-border py-2"
    >
      <PolDot polarity={s.polarity} className="mt-1.25" />
      <div className="m-0 text-sm text-fg" title={s.title}>
        <Fact1 f={s.fact} />
        {s.note && ui.onOpenNote && (
          <>
            {" · "}
            <button
              type="button"
              className={lnk}
              onClick={() => ui.onOpenNote?.(s.note?.noteId ?? null, s.note?.segment ?? null)}
            >
              {S.note}
            </button>
          </>
        )}
        {s.age.text && (
          <span
            title={s.age.title}
            className={`ml-2 text-xs ${s.age.warn ? "text-warning" : "text-fg-muted"}`}
          >
            {s.age.text}
          </span>
        )}
      </div>
      <div>
        {!grouped && ui.ackBusy(s.id) && (
          <Spinner className="mr-1.5 inline-block align-middle text-xs text-fg-muted" />
        )}
        {!grouped && (
          <button
            type="button"
            disabled={ui.ackBusy(s.id)}
            onClick={() => ui.onAck(s.id)}
            className="cursor-pointer border-0 bg-transparent p-0 text-xs text-fg-muted no-underline opacity-0 group-hover/orow:opacity-100 group-focus-within/orow:opacity-100 group-hover/orow:text-accent group-focus-within/orow:text-accent group-hover/orow:underline group-focus-within/orow:underline pointer-coarse:opacity-100 disabled:cursor-default"
          >
            {S.ack}
          </button>
        )}
      </div>
    </div>
  );
}

export function AssetDetailView({
  model: m,
  mode,
  ui,
  slots,
}: {
  model: AssetModel;
  mode: AssetMode;
  ui: AssetDetailUi;
  slots: AssetDetailSlots;
}) {
  const drawer = mode === "drawer";
  const h = m.head;
  const head = (
    <section
      aria-label={m.name}
      className={`col-span-2 flex min-w-0 flex-row flex-wrap items-center rounded-widget border border-border bg-surface-raised shadow-card max-narrow:col-auto ${drawer ? "gap-x-3.5 gap-y-2.5 px-4 py-3" : "gap-x-4.5 gap-y-3 px-5 py-3.5"}`}
    >
      <div>
        <h2
          className={`m-0 font-heavy tracking-heading text-fg ${drawer ? "text-lg-plus" : "text-2xl"}`}
        >
          {h.tile ? (
            <InstLabel {...h.tile} density="header" heading name={m.name} sub={h.labelSub} />
          ) : (
            m.name
          )}
        </h2>
        <div className="mt-0.5 text-xs-plus text-fg-muted">
          {h.sub}
          {h.state && (
            <>
              {" · "}
              <button
                type="button"
                onClick={() =>
                  document
                    .getElementById(`asset-signals-${m.id}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
                className="inline-flex cursor-pointer items-center gap-1.25 border-0 bg-transparent p-0 align-baseline text-xs-plus text-fg-muted no-underline hover:text-accent [&>span]:m-0 [&>span]:size-1.75"
              >
                <PolDot state={h.state.state} /> {h.state.label}
              </button>
            </>
          )}
          {h.hint && (
            <>
              {" · "}
              <span className="align-[--spacing(-0.25)]">
                <HintChip {...h.hint} />
              </span>
            </>
          )}
        </div>
      </div>
      <div aria-hidden="true" className={sep} />
      <div>
        <div
          className={`font-heavy tracking-heading tabular-nums ${drawer ? "text-2xl" : "text-3xl-plus"}`}
        >
          {h.price}
          {h.week && <span className={`ml-1.5 text-sm ${tone(h.week.tone)}`}>{h.week.text}</span>}
        </div>
        <div className="text-xs text-fg-muted">
          {h.date}
          {h.fromHigh && (
            <>
              {" · "}
              {S.fromHigh} <b className={tone(h.fromHigh.tone)}>{h.fromHigh.text}</b>
            </>
          )}
        </div>
      </div>
      {h.facts && (
        <>
          <div aria-hidden="true" className={sep} />
          <div className="flex flex-wrap gap-y-2">
            {[
              {
                key: "value",
                label: S.value,
                value: h.facts.value,
                detail: h.facts.valueDetail,
              },
              {
                key: "result",
                label: S.result,
                value: h.facts.result.text,
                tone: h.facts.result.tone,
                detail: h.facts.resultPct,
              },
              { key: "cost", label: S.avgCostFact, value: h.facts.avgCost },
              { key: "qty", label: S.quantity, value: h.facts.quantity },
            ].map((f) => (
              <Fact
                key={f.key}
                size="sm"
                label={f.label}
                value={f.value}
                detail={f.detail}
                tone={f.tone}
                className="mr-4.5 border-r border-border pr-4.5 last:mr-0 last:border-r-0"
              />
            ))}
          </div>
        </>
      )}
      <span className="flex-1" />
      <div className={`flex items-center gap-2 ${drawer ? "ml-auto" : ""}`}>
        {h.watch === "watching" && (
          <Button title={S.unwatch} disabled={ui.watchBusy} onPress={ui.onToggleWatch}>
            <span className="text-positive">
              <span aria-hidden="true">✓ </span>
              {S.watching}
            </span>
          </Button>
        )}
        {h.watch === "watch" && (
          <Button disabled={ui.watchBusy} onPress={ui.onToggleWatch}>
            {S.watch}
          </Button>
        )}
        {h.canTxn && <Button onPress={ui.onAddTxn}>{S.addTxn}</Button>}
        <Button
          variant="primary"
          disabled={!h.canDecide}
          title={h.canDecide ? undefined : S.noOpenSignal}
          onPress={ui.onDecide}
        >
          {S.recordDecision}
        </Button>
      </div>
      {h.showMeta && (
        <div className="-mt-0.5 flex basis-full flex-wrap items-center gap-x-1.5 gap-y-1 text-xs-plus text-fg-muted">
          {h.meta.map((it, k) => (
            <span key={it.kind} className="inline-flex items-center gap-1.5">
              {k > 0 && <span aria-hidden="true">·</span>}
              {it.kind === "lots" ? (
                it.toggle ? (
                  <button
                    type="button"
                    className={lnk}
                    aria-expanded={ui.lotsOpen}
                    aria-controls={`hlots-${m.id}`}
                    onClick={ui.toggleLots}
                  >
                    {it.text}
                    <span className="text-3xs">{ui.lotsOpen ? " ▴" : " ▾"}</span>
                  </button>
                ) : (
                  <span>{it.text}</span>
                )
              ) : it.kind === "txns" ? (
                <button type="button" className={lnk} onClick={ui.onTxns}>
                  {it.text}
                </button>
              ) : (
                <span>
                  {it.label} <b className="font-strong text-fg tabular-nums">{it.value}</b>
                </span>
              )}
            </span>
          ))}
          {h.segment && ui.segment && (
            <span className="inline-flex items-center gap-1.5">
              {h.meta.length > 0 && <span aria-hidden="true">·</span>}
              <span>{SG.topic}</span>
              <Select
                label={SG.topic}
                labelHidden
                compact
                value={ui.segment.value}
                disabled={ui.segment.busy}
                title={ui.segment.title}
                options={h.segment.options}
                onChange={ui.segment.onChange}
              />
            </span>
          )}
        </div>
      )}
      {h.lots && (
        <div
          id={`hlots-${m.id}`}
          className={`basis-full border-t border-border ${drawer ? "-mx-4 mt-0.5 -mb-3 px-4 pb-1" : "-mx-5 mt-0.5 -mb-3.5 px-5 pb-1.5"}`}
        >
          <table className="w-full border-collapse text-xs-plus">
            <thead>
              <tr>
                {[
                  { k: "d", t: S.lotDate, num: false },
                  { k: "q", t: S.lotQty, num: true },
                  { k: "p", t: S.lotPrice, num: true },
                  { k: "r", t: S.lotResult, num: true },
                  { k: "rp", t: S.lotResultPct, num: true },
                ].map((c) => (
                  <th
                    key={c.k}
                    className={`whitespace-nowrap border-b border-border px-2 py-1.25 text-2xs font-strong uppercase tracking-label text-fg-muted first:pl-0 ${c.num ? "text-right tabular-nums" : "text-left"}`}
                  >
                    {c.t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {h.lots.map((l) => (
                <tr key={l.key} className="[&:last-child>td]:border-b-0">
                  <td className="border-b border-border px-2 py-1.25 pl-0 align-middle tabular-nums">
                    {l.date}
                    {l.account && (
                      <span className="-mt-px block text-2xs-plus text-fg-muted">{l.account}</span>
                    )}
                  </td>
                  <td className={numTd}>{l.quantity}</td>
                  <td className={numTd}>{l.price}</td>
                  <td className={`${numTd} ${tone(l.result.tone)}`}>{l.result.text}</td>
                  <td className={`${numTd} ${tone(l.resultPct.tone)}`}>{l.resultPct.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );

  const ch = m.chart;
  const priceChart = (
    <Widget
      title={S.chartTitle}
      count={ch.currency}
      className="col-span-2 max-narrow:col-auto"
      tight
      controls={
        <Seg
          quiet
          label={S.range}
          value={ch.months}
          onChange={ui.setMonths}
          items={ch.monthItems}
        />
      }
      footer={
        ch.foot.length > 0
          ? ch.foot.map((f) => (
              <span key={f.label}>
                {f.label} <b>{f.value}</b>
              </span>
            ))
          : undefined
      }
    >
      <ChartLegend className="mb-1.5" items={ch.legend} />
      {ch.body.kind === "empty" ? (
        <div className="px-3 py-4.5 text-center text-sm text-fg-muted">{ch.body.text}</div>
      ) : (
        <LineChart
          label={ch.body.label}
          height={ch.body.height}
          padL={ch.body.padL}
          padR={ch.body.padR}
          yTicks={5}
          yFormat={ch.body.yFormat}
          valueKind="share"
          xLabels={ch.body.xLabels}
          series={[{ values: ch.body.values, color: "accent", endLabel: ch.body.endLabel }]}
          levels={ch.body.levels}
          markers={ch.body.markers}
          tooltip={ch.body.tooltip}
        />
      )}
    </Widget>
  );

  const th = m.thesisW;
  const thesisW = th && (
    <Widget
      title={S.thesis}
      tight
      tags={
        <>
          {th.entryType && <span className={subCls}>{th.entryType}</span>}
          {slots.thesisTags}
        </>
      }
      controls={
        <Button size="sm" onPress={ui.onThesis}>
          {th.action}
        </Button>
      }
    >
      {th.parts ? (
        <div>
          {th.parts.map((p) => (
            <p key={p.key} className={tzP}>
              <b className={tzB}>{p.label}</b>
              {p.text}
            </p>
          ))}
        </div>
      ) : (
        <div className={muted13}>{S.noThesis}</div>
      )}
    </Widget>
  );

  const rc = m.recW;
  const quiet = rc?.tint ? tintInk : "text-fg-muted";
  const recW = rc && (
    <Widget
      title={rc.title}
      tint={rc.tint}
      tight
      tags={
        <>
          {rc.date && (
            <span title={rc.dateTitle} className={`text-xs-plus font-medium ${quiet}`}>
              {rc.date}
            </span>
          )}
          {rc.fresh && (
            <span
              title={rc.fresh.title}
              className={`inline-block whitespace-nowrap rounded-full border px-1.75 py-px text-2xs leading-normal ${rc.fresh.out ? freshOut : freshMaybe}`}
            >
              {rc.fresh.text}
            </span>
          )}
        </>
      }
    >
      <div role="note" aria-label={rc.aria} data-fresh={rc.freshKey ?? undefined}>
        {rc.strength && (
          <div className="flex flex-wrap items-center gap-x-1.5 text-sm-plus">
            <PolDot state={rc.strength.glyph} title={rc.strength.label} />
            <b className="font-strong">{rc.strength.label}</b>
            {rc.strength.basis && <span className={quiet}>· {rc.strength.basis}</span>}
          </div>
        )}
        {rc.rec && (
          <b
            className={`inline-flex items-center gap-1.5 font-strong ${rc.strength ? "mt-1 text-sm" : "text-sm-plus"}`}
          >
            <PlanGlyph path={rc.rec.path} />
            {rc.rec.label}
          </b>
        )}
        {rc.reason && <p className="mt-1.5 mb-0 text-sm leading-widget">{rc.reason}</p>}
        {rc.reasons.length > 0 && (
          <ul
            aria-label={S.reasons}
            className={`mt-2 mb-0 grid list-none gap-0.5 p-0 text-xs tabular-nums ${quiet}`}
          >
            {rc.reasons.map((r) => (
              <li key={r.key}>
                {r.noteId != null && ui.onOpenNote ? (
                  <button
                    type="button"
                    onClick={() => ui.onOpenNote?.(r.noteId, null)}
                    className="cursor-pointer border-0 bg-transparent p-0 text-xs text-inherit underline decoration-[color-mix(in_srgb,currentColor_40%,transparent)] underline-offset-2 hover:text-accent"
                  >
                    {r.text}
                  </button>
                ) : (
                  r.text
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Widget>
  );

  const alertsW = (
    <Widget
      title={S.alerts}
      tight
      controls={
        <button type="button" className={lnk} onClick={ui.onAlerts}>
          {S.all}
        </button>
      }
    >
      {!m.live.length ? <div className={muted13}>{S.noAlerts}</div> : slots.alertRows}
    </Widget>
  );

  const n = ui.note;
  const watchW = m.watchW && (
    <Widget
      title={S.whyWatch}
      tight
      controls={
        n.draft == null ? (
          <Button size="sm" onPress={n.onEdit}>
            {n.saved ? C.edit : C.add}
          </Button>
        ) : undefined
      }
    >
      {n.draft != null ? (
        <div data-esc-local="" className="grid gap-2">
          <TextField
            label={S.whyWatch}
            labelHidden
            multiline
            rows={4}
            maxLength={1000}
            autoFocus
            value={n.draft}
            onChange={n.onDraft}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                n.onCancel();
              }
            }}
          />
          {n.error && <div className="text-xs-plus text-negative">{n.error}</div>}
          <div className="flex justify-end gap-2">
            <Button size="sm" disabled={n.busy} onPress={n.onCancel}>
              {C.cancel}
            </Button>
            <Button size="sm" variant="primary" disabled={n.busy} onPress={n.onSave}>
              {C.save}
            </Button>
          </div>
        </div>
      ) : n.saved ? (
        <div>
          <p className={`${tzP} whitespace-pre-wrap`}>{n.saved}</p>
        </div>
      ) : (
        <div className={muted13}>{S.noNote}</div>
      )}
    </Widget>
  );

  const research = slots.research ?? null;
  const timelineW = (
    <Widget
      title={S.signalsDecisions}
      id={`asset-signals-${m.id}`}
      tight
      className={m.thesisW || m.recW || research ? "col-span-2 max-narrow:col-auto" : undefined}
      controls={
        <button type="button" className={lnk} onClick={ui.onJournal}>
          {S.journal}
        </button>
      }
    >
      {m.open.length > 0 && (
        <div>
          {m.open.map((s) => (
            <OpenSignalRow key={s.id} s={s} grouped={m.open.length > 1} ui={ui} />
          ))}
          {m.open.length > 1 && (
            <div className="flex gap-1 pt-0.5 pb-1.5 pl-4.5">
              <Button
                size="sm"
                disabled={ui.ackAllBusy}
                title={S.ackTitle(m.open.length)}
                onPress={ui.onAckAll}
              >
                {S.ackAll}
              </Button>
            </div>
          )}
        </div>
      )}
      {!m.timeline.length && !m.open.length ? (
        <div className={muted13}>{S.noSignalsDecisions}</div>
      ) : (
        m.timeline.length > 0 && (
          <div
            className={`grid grid-cols-[--spacing(17.5)_--spacing(2.5)_minmax(0,1fr)] gap-x-2.5 text-xs-plus ${m.open.length ? "mt-2 border-t border-border pt-1" : ""}`}
          >
            {m.timeline.map((e) => (
              <div key={e.key} className="contents">
                <div className="whitespace-nowrap py-1.25 text-fg-muted tabular-nums">{e.date}</div>
                <div className="flex justify-center py-1.25">
                  <i
                    aria-hidden="true"
                    className={`mt-1.25 size-2 rounded-full ${dotCls[e.dot]}`}
                  />
                </div>
                <div className="min-w-0 border-b border-border py-1.25" title={e.title}>
                  <b className="font-strong">{e.head}</b>
                  {e.fact ? ` · ${e.fact}` : ""}
                  {e.tail && <span className="text-fg-muted"> · {e.tail}</span>}
                  {e.sub && (
                    <div className="mt-px overflow-hidden text-ellipsis whitespace-nowrap text-xs text-fg-muted">
                      {e.sub}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </Widget>
  );

  // Two columns: Dlaczego obserwuję, Teza + Rekomendacja on the left, Alerty above research on the right. With
  // nothing on the left Alerty move there; a right column left empty takes the timeline.
  const left = watchW || thesisW || recW;
  const leftCol = left ? (
    <div className={stack}>
      {watchW}
      {thesisW}
      {recW}
    </div>
  ) : (
    <div className={stack}>{alertsW}</div>
  );
  const rightCol = left ? (
    <div className={stack}>
      {alertsW}
      {research}
    </div>
  ) : (
    research
  );
  return (
    <div className="grid grid-cols-2 items-start gap-4 text-md leading-widget max-narrow:grid-cols-1 [&>*]:min-w-0">
      {head}
      {priceChart}
      {leftCol}
      {rightCol ?? timelineW}
      {rightCol && timelineW}
      {slots.decision}
    </div>
  );
}

const numTd =
  "whitespace-nowrap border-b border-border px-2 py-1.25 text-right align-middle tabular-nums";
const subCls = "text-xs-plus font-medium text-fg-muted";
const tzP = "mt-0 mb-1.5 text-sm leading-widget";
const tzB = "block text-2xs font-strong uppercase tracking-label text-fg-muted";
const stack = "grid content-start gap-4 [&>*]:min-w-0";
const freshMaybe =
  "border-[color-mix(in_srgb,var(--color-warning)_75%,var(--color-fg))] text-[color-mix(in_srgb,var(--color-warning)_75%,var(--color-fg))]";
const freshOut =
  "border-[color-mix(in_srgb,var(--color-negative)_75%,var(--color-fg))] text-[color-mix(in_srgb,var(--color-negative)_75%,var(--color-fg))]";
const dotCls: Record<string, string> = {
  pos: "bg-positive",
  neg: "bg-negative",
  nw: "bg-accent",
  neu: "bg-border",
  "": "bg-border",
};
