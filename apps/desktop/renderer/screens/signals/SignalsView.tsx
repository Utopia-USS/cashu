import { D, Money as MoneyValue } from "@cashu/domain";
import { Amount, DateText, Modal, Money, Percent, Sparkline } from "@cashu/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useVirtualRows } from "../../presentation/useVirtualRows.js";
import { investmentMarks } from "../investments/presentation.js";
import { alertPresentation, alertSignalObserved, signalDisplayDay } from "./presentation.js";
import { G } from "./Signals.strings.js";
import type { SignalRow, SignalsPageKind, SignalsScreenState } from "./useSignalsScreen.js";

const card = "rounded-lg border border-border bg-surface-raised p-4";
const button =
  "rounded-sm border border-border px-3 py-2 hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
const date = (text: string | null) => signalDisplayDay(text);
const tone = (value: string) =>
  (
    ({ positive: G.positive, negative: G.negative, neutral: G.neutral, mixed: G.mixed }) as Record<
      string,
      string
    >
  )[value] ?? G.code(value);
const status = (value: string) =>
  (
    ({
      active: G.active,
      triggered: G.triggered,
      snoozed: G.snoozed,
      muted: G.muted,
      expired: G.expired,
      open: G.open,
      decided: G.decided,
      acknowledged: G.acknowledged,
      closed: G.closed,
      held: G.heldInstrument,
      watched: G.watched,
      saved: G.savedInstrument,
      new: G.new,
      info: G.info,
      action: G.urgent,
    }) as Record<string, string>
  )[value] ?? G.code(value);
const scope = (value: string) =>
  (
    ({ instrument: G.instrument, portfolio: G.portfolio, bucket: G.bucket }) as Record<
      string,
      string
    >
  )[value] ?? G.code(value);
const decision = (value: string) =>
  (
    ({
      held: G.held,
      bought: G.buy,
      sold: G.sell,
      other: G.later,
      acknowledged: G.acknowledged,
    }) as Record<string, string>
  )[value] ?? G.code(value);
const notice = (value: string) =>
  (
    ({
      removed: G.removed,
      restored: G.restored,
      unknown: G.unknown,
      unavailable: G.writeUnavailable,
      previous_completed: G.previousCompleted,
      previous_refused: G.previousRefused,
      partial: G.savedPartial,
      skipped: G.alreadySettled,
      cleanup: G.savedCleanup,
      cache: G.savedCache,
      watch_warning: G.savedWatchWarning,
      failed: G.failed,
    }) as Record<string, string>
  )[value] ?? G.saved;
const runStatus = (value: string) =>
  (
    ({ ok: G.runOk, partial: G.runPartial, failed: G.runFailed, running: G.runRunning }) as Record<
      string,
      string
    >
  )[value] ?? G.code(value);

/** The Home rail reuses the same tracked snapshot and owner callbacks as the full dialog. */
export function SignalsHomeRailView({ state }: { state: SignalsScreenState }) {
  const rows = state.groups.filter((group) => !group.settled).slice(0, 4);
  return (
    <section className={card} data-testid="native-signals-rail">
      <header className="flex items-center justify-between">
        <h2>{G.signals}</h2>
        <button type="button" className={button} onClick={() => state.setDialogOpen(true)}>
          {G.all} <Amount value={D(String(state.groups.length))} fractionDigits={0} />
        </button>
      </header>
      {state.data === null ? (
        <p>{state.privacy ? G.privacy : G.unavailable}</p>
      ) : rows.length === 0 ? (
        <p>{G.empty}</p>
      ) : (
        <div className="grid gap-2 py-2">
          {rows.map((group) => (
            <button
              key={group.key}
              type="button"
              className={`${button} flex items-center justify-between text-left`}
              onClick={() => {
                state.setDialogOpen(true);
                state.setCursor(group.primary?.gid ?? null);
              }}
            >
              <span>{group.primary?.instrumentLabel ?? group.primary?.message ?? group.key}</span>
              <span>
                <Amount value={D(String(group.live.length))} fractionDigits={0} />{" "}
                {tone(group.state)}
              </span>
            </button>
          ))}
        </div>
      )}
      {state.data && (
        <div className="grid gap-1 py-2 text-sm">
          <p>
            {G.lastRun}:{" "}
            {state.data.lastRun ? (
              <>
                <DateText
                  value={date(state.data.lastRun.finishedAt ?? state.data.lastRun.startedAt)}
                />{" "}
                · {runStatus(state.data.lastRun.status)}
              </>
            ) : (
              G.neverRun
            )}
          </p>
          <p>
            {G.expiredSignals}:{" "}
            <Amount
              value={D(String(state.data.signals.filter((row) => row.status === "expired").length))}
              fractionDigits={0}
            />
          </p>
          {state.data.decisions.length > 0 && (
            <div>
              <strong>{G.recentDecisions}</strong>
              {state.data.decisions.slice(0, 2).map((row) => (
                <p key={row.gid}>
                  <DateText value={date(row.createdAt)} /> · {decision(row.action)} ·{" "}
                  {row.reason ?? ""}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2 border-t border-border pt-2">
        <button
          type="button"
          className={button}
          onClick={() => state.options.onOpenPage?.("alerts")}
        >
          {G.alerts}
        </button>
        <button
          type="button"
          className={button}
          onClick={() => state.options.onOpenPage?.("watchlist")}
        >
          {G.watchlist}
        </button>
        <button
          type="button"
          className={button}
          onClick={() => state.options.onOpenPage?.("journal")}
        >
          {G.journal}
        </button>
        {state.options.onOpenReview && (
          <button type="button" className={button} onClick={state.options.onOpenReview}>
            {G.review}
          </button>
        )}
      </div>
    </section>
  );
}

type Flat =
  | { key: string; kind: "group"; group: SignalsScreenState["groups"][number] }
  | { key: string; kind: "signal"; signal: SignalRow; group: SignalsScreenState["groups"][number] };
function GroupList({
  state,
  scope,
}: {
  state: SignalsScreenState;
  scope: "portfolio" | "watched";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const flat: Flat[] = state.groups
    .filter((group) => group.scope === scope)
    .flatMap((group) => [
      { key: group.key, kind: "group" as const, group },
      ...group.signals.map((signal) => ({
        key: signal.gid,
        kind: "signal" as const,
        signal,
        group,
      })),
    ]);
  const virtual = useVirtualRows({
    count: flat.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 74,
    getItemKey: (index) => flat[index]?.key ?? index,
    overscan: 5,
  });
  return (
    <section className="min-w-0">
      <h3 className="sticky top-0 z-10 bg-surface p-2">
        {scope === "portfolio" ? G.portfolio : G.watched}{" "}
        <Amount
          value={D(String(flat.filter((item) => item.kind === "signal").length))}
          fractionDigits={0}
        />
      </h3>
      <section
        ref={ref}
        className="max-h-96 overflow-auto"
        aria-label={scope === "portfolio" ? G.portfolio : G.watched}
      >
        <div className="relative" style={{ height: virtual.totalSize }}>
          {virtual.items.map((item) => {
            const row = flat[item.index];
            if (!row) return null;
            return (
              <div
                key={item.key}
                ref={virtual.measureElement}
                data-index={item.index}
                className="absolute left-0 top-0 w-full border-b border-border p-2"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {row.kind === "group" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>
                      {row.group.primary?.instrumentLabel ??
                        row.group.primary?.message ??
                        row.group.key}
                    </strong>
                    <span>{row.group.settled ? G.settled : tone(row.group.state)}</span>
                    {!row.group.settled && (
                      <>
                        <button
                          type="button"
                          className={button}
                          disabled={state.busy}
                          onClick={() => state.setSelectedGroup(row.group.key)}
                        >
                          {G.decide}
                        </button>
                        <button
                          type="button"
                          className={button}
                          disabled={state.busy}
                          onClick={() => state.acknowledgeGroup(row.group.key)}
                        >
                          {G.acknowledge}
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <SignalLine state={state} row={row.signal} />
                )}
              </div>
            );
          })}
        </div>
      </section>
    </section>
  );
}
function SignalLine({ state, row }: { state: SignalsScreenState; row: SignalRow }) {
  const hasDecision = row.decisions.length > 0;
  const until = state.next;
  return (
    <div
      className="grid gap-1"
      data-signal={row.gid}
      tabIndex={-1}
      aria-current={state.cursor === row.gid ? "true" : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden>
          {row.polarity === "positive" ? "●" : row.polarity === "negative" ? "◆" : "■"}
        </span>
        <span>{row.message}</span>
        <DateText value={date(row.firstSeenAt)} />
        <span className={row.current ? "text-fg-muted" : "text-warning"}>
          {row.current ? G.current : G.unconfirmed}
        </span>
        {row.snoozed && <span>{G.snoozed}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        {row.instrument !== null && (
          <button
            type="button"
            className={button}
            onClick={() => {
              state.setDialogOpen(false);
              state.options.onOpenAsset?.(row.instrument as string);
            }}
          >
            {G.opens}
          </button>
        )}
        {row.note && state.options.onOpenNote && (
          <button
            type="button"
            className={button}
            onClick={() => {
              state.setDialogOpen(false);
              state.options.onOpenNote?.(
                row.note,
                row.instrument,
                typeof row.payload.segment === "string" ? row.payload.segment : null,
              );
            }}
          >
            {G.note}
          </button>
        )}
        {!hasDecision && !row.snoozed && until && (
          <button
            type="button"
            className={button}
            disabled={state.busy}
            onClick={() => void state.snoozeUntil(row.gid, until)}
          >
            {G.nextDeposit}
          </button>
        )}
        {row.snoozed && (
          <button
            type="button"
            className={button}
            disabled={state.busy}
            onClick={() => void state.snooze(row.gid, null)}
          >
            {G.undo}
          </button>
        )}
        {hasDecision && (
          <button
            type="button"
            className={button}
            disabled={state.busy}
            onClick={() => {
              const decision = row.decisions.at(-1);
              if (decision) void state.undoOne(decision.gid);
            }}
          >
            {G.undo}
          </button>
        )}
      </div>
    </div>
  );
}
function DecisionDialog({ state }: { state: SignalsScreenState }) {
  const group = state.selected;
  if (!group) return null;
  const form = state.decisionForm;
  return (
    <Modal
      label={G.decide}
      onClose={() => state.setSelectedGroup(null)}
      className="mx-auto max-w-xl p-5"
    >
      <header className="flex items-center justify-between">
        <h2>
          {G.decide}: {group.primary?.instrumentLabel ?? group.primary?.message}
        </h2>
        <button type="button" className={button} onClick={() => state.setSelectedGroup(null)}>
          {G.close}
        </button>
      </header>
      <div className="py-3">
        <h3>{G.context}</h3>
        {group.live.slice(0, 5).map((row) => (
          <p key={row.gid}>
            {row.message} <DateText value={date(row.firstSeenAt)} />
          </p>
        ))}
        {group.live.length > 5 && <p>{G.more(group.live.length - 5)}</p>}
        {state.data?.theses
          .filter((thesis) => thesis.instrument === group.instrument)
          .slice(0, 1)
          .map((thesis) => (
            <p key={thesis.gid}>
              {G.thesis}: {thesis.thesis}
              {thesis.exitPlan && (
                <>
                  {" "}
                  · {G.exitPlan}: {thesis.exitPlan}
                </>
              )}
            </p>
          ))}
        {group.primary?.kind === "contribution_gap" && state.next && (
          <p>
            {G.nextDeposit}: <DateText value={state.next} />
          </p>
        )}
        {state.suggestion.quantity && (
          <p>
            {G.suggestedQuantity}: <Amount value={state.suggestion.quantity} fractionDigits={0} />
          </p>
        )}
        {state.suggestion.quantityUnavailable && <p>{G.quantityUnavailable}</p>}
        {state.estimate && (
          <p>
            {G.estimate}:{" "}
            <Money value={new MoneyValue(state.estimate.amount, state.estimate.currency)} />
            {state.estimate.allocation && (
              <>
                {" "}
                · {G.afterWeight}:{" "}
                <Percent value={D(String(state.estimate.allocation.afterWeight))} /> ·{" "}
                {G.targetWeight}: <Percent value={D(String(state.estimate.allocation.target))} /> ·{" "}
                {G.drift}:{" "}
                <Amount value={D(String(state.estimate.allocation.driftPp))} fractionDigits={1} />{" "}
                {G.pp}
              </>
            )}
          </p>
        )}
      </div>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="action">
          {(field) => (
            <label>
              {G.action}
              <select
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                className="block w-full rounded-sm border border-border bg-surface p-2"
              >
                <option value="held">{G.held}</option>
                <option value="bought">{G.buy}</option>
                <option value="sold">{G.sell}</option>
                <option value="other">{G.later}</option>
              </select>
            </label>
          )}
        </form.Field>
        <form.Field name="account">
          {(field) => (
            <label>
              {G.account}
              <select
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                className="block w-full rounded-sm border border-border bg-surface p-2"
              >
                <option value="">-</option>
                {state.data?.accounts.map((account) => (
                  <option key={account.gid} value={account.gid}>
                    {account.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </form.Field>
        <div className="grid grid-cols-3 gap-2">
          <form.Field name="quantity">
            {(field) => (
              <label>
                {G.quantity}
                <input
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  inputMode="decimal"
                  className="block w-full rounded-sm border border-border bg-surface p-2"
                />
              </label>
            )}
          </form.Field>
          <form.Field name="price">
            {(field) => (
              <label>
                {G.price}
                <input
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  inputMode="decimal"
                  className="block w-full rounded-sm border border-border bg-surface p-2"
                />
              </label>
            )}
          </form.Field>
          <form.Field name="currency">
            {(field) => (
              <label>
                {G.currency}
                <input
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  className="block w-full rounded-sm border border-border bg-surface p-2"
                />
              </label>
            )}
          </form.Field>
        </div>
        <form.Field name="reason">
          {(field) => (
            <label>
              {G.reason}
              <textarea
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                className="block w-full rounded-sm border border-border bg-surface p-2"
              />
            </label>
          )}
        </form.Field>
        <p>{G.noTrade}</p>
        <div className="flex gap-2">
          <button type="submit" className={button} disabled={state.busy}>
            {G.save}
          </button>
          <button type="button" className={button} onClick={() => state.setSelectedGroup(null)}>
            {G.cancel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function SignalsDialogView({ state }: { state: SignalsScreenState }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!state.dialogOpen || state.cursor === null) return;
    ref.current
      ?.querySelector<HTMLElement>(`[data-signal="${state.cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [state.dialogOpen, state.cursor]);
  if (!state.dialogOpen) return <DecisionDialog state={state} />;
  const close = () => {
    state.setDialogOpen(false);
    state.options.onClose?.();
  };
  const rows = state.groups.flatMap((group) => group.signals);
  const move = (delta: number) => {
    const index = rows.findIndex((row) => row.gid === state.cursor);
    state.setCursor(rows[Math.max(0, Math.min(rows.length - 1, index + delta))]?.gid ?? null);
  };
  return (
    <>
      <Modal
        label={G.signals}
        onClose={close}
        panelRef={ref}
        focus="panel"
        onKeyDown={(event) => {
          if (state.selected) return;
          if (event.key === "Escape") close();
          if (event.key === "j" || event.key === "ArrowDown") {
            event.preventDefault();
            move(1);
          }
          if (event.key === "k" || event.key === "ArrowUp") {
            event.preventDefault();
            move(-1);
          }
          if (event.key === "Enter" && state.cursor) {
            const group = state.groups.find((row) =>
              row.signals.some((signal) => signal.gid === state.cursor),
            );
            if (group) state.setSelectedGroup(group.key);
          }
        }}
      >
        <header className="flex flex-wrap items-center gap-2">
          <h2>{G.signals}</h2>
          <button
            type="button"
            className={button}
            aria-pressed={state.filter === "all"}
            onClick={() => state.setFilter("all")}
          >
            {G.all}
          </button>
          <button
            type="button"
            className={button}
            aria-pressed={state.filter === "positive"}
            onClick={() => state.setFilter("positive")}
          >
            {G.chances}
          </button>
          <button
            type="button"
            className={button}
            aria-pressed={state.filter === "negative"}
            onClick={() => state.setFilter("negative")}
          >
            {G.risks}
          </button>
          <span className="flex-1" />
          <button type="button" className={button} onClick={close}>
            {G.close}
          </button>
        </header>
        {state.notice && <p role="status">{notice(state.notice)}</p>}
        {state.refusal && <p role="alert">{G.code(state.refusal)}</p>}
        {state.data === null ? (
          <p>{G.unavailable}</p>
        ) : rows.length === 0 ? (
          <p>{G.empty}</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <GroupList state={state} scope="portfolio" />
            <GroupList state={state} scope="watched" />
          </div>
        )}
        <footer className="flex flex-wrap gap-2 border-t border-border pt-3">
          <button
            type="button"
            className={button}
            onClick={() => {
              state.setDialogOpen(false);
              state.options.onOpenPage?.("watchlist");
            }}
          >
            {G.watchlist}
          </button>
          <button
            type="button"
            className={button}
            onClick={() => {
              state.setDialogOpen(false);
              state.options.onOpenPage?.("journal");
            }}
          >
            {G.journal}
          </button>
        </footer>
      </Modal>
      <DecisionDialog state={state} />
    </>
  );
}

export function SignalsPageView({
  state,
  page,
  editor,
}: {
  state: SignalsScreenState;
  page: SignalsPageKind;
  editor?: ReactNode;
}) {
  return (
    <main className="grid gap-4 p-6" data-testid={`native-signals-${page}`}>
      <header className="flex flex-wrap items-center gap-3">
        <button type="button" className={button} onClick={state.options.onClose}>
          {G.portfolio}
        </button>
        <h1 className="text-headline font-strong">
          {page === "alerts" ? G.alerts : page === "watchlist" ? G.watchlist : G.journal}
        </h1>
      </header>
      {state.notice && <p role="status">{notice(state.notice)}</p>}
      {state.refusal && <p role="alert">{G.code(state.refusal)}</p>}
      {state.undoIds.length > 0 && (
        <button type="button" className={button} onClick={() => void state.undoDecisions()}>
          {G.undo}
        </button>
      )}
      {state.data === null ? (
        <p>{state.privacy ? G.privacy : G.unavailable}</p>
      ) : page === "alerts" ? (
        <AlertsPage state={state} editor={editor} />
      ) : page === "watchlist" ? (
        <WatchlistPage state={state} />
      ) : (
        <JournalPage state={state} />
      )}
      <SignalsDialogView state={state} />
    </main>
  );
}

function AlertsPage({ state, editor }: { state: SignalsScreenState; editor?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const rows = state.shownAlerts;
  const virtual = useVirtualRows({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 92,
    getItemKey: (index) => rows[index]?.gid ?? index,
    overscan: 5,
  });
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <select
          value={state.alertStatus}
          onChange={(event) => state.setAlertStatus(event.target.value)}
          aria-label={G.status}
          className={button}
        >
          {["all", "active", "triggered", "snoozed", "muted", "expired"].map((value) => (
            <option key={value} value={value}>
              {value === "all" ? G.all : status(value)}
            </option>
          ))}
        </select>
        <select
          value={state.alertSource}
          onChange={(event) => state.setAlertSource(event.target.value)}
          aria-label={G.source}
          className={button}
        >
          <option value="all">{G.all}</option>
          <option value="user">{G.you}</option>
          <option value="agent">{G.agent}</option>
        </select>
        <button type="button" className={button} onClick={() => state.setEditingAlert("new")}>
          {G.alertsNew}
        </button>
        {state.removedAlert && (
          <button type="button" className={button} onClick={() => void state.restoreDeletedAlert()}>
            {G.restore}
          </button>
        )}
      </div>
      {editor}
      <section className={card}>
        <h2>{G.alerts}</h2>
        {state.data && (
          <div className="flex flex-wrap gap-3 py-2 text-sm">
            <span>
              {G.active}: <Amount value={D(String(state.data.counts.active))} fractionDigits={0} />
            </span>
            <span>
              {G.triggered}:{" "}
              <Amount value={D(String(state.data.counts.triggered))} fractionDigits={0} />
            </span>
            <span>
              {G.snoozed}:{" "}
              <Amount value={D(String(state.data.counts.snoozed))} fractionDigits={0} />
            </span>
            <span>
              {G.agentLive}:{" "}
              <Amount value={D(String(state.data.counts.agentLive))} fractionDigits={0} />
            </span>
          </div>
        )}
        {rows.length === 0 ? (
          <p>{G.noRows}</p>
        ) : (
          <div ref={ref} className="max-h-96 overflow-auto">
            <div className="relative" style={{ height: virtual.totalSize }}>
              {virtual.items.map((item) => {
                const row = rows[item.index];
                if (!row) return null;
                const alert = alertPresentation(row);
                return (
                  <div
                    key={item.key}
                    ref={virtual.measureElement}
                    data-index={item.index}
                    className="absolute left-0 top-0 w-full border-b border-border p-2"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <div className="flex flex-wrap justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <strong>{row.title}</strong>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs ${row.status === "triggered" ? "bg-positive-bg text-positive" : row.status === "active" ? "bg-info-bg text-accent" : "bg-surface-sunken text-fg-muted"}`}
                          >
                            {alert.tag}
                          </span>
                          <span className="rounded-sm border border-border px-1.5 py-0.5 text-xs">
                            {status(row.status)}
                          </span>
                          {row.source === "agent" && (
                            <span className="rounded-sm border border-border px-1.5 py-0.5 text-xs">
                              {G.agent}
                            </span>
                          )}
                        </div>
                        <p>
                          {alert.condition} · {row.instrumentDetail?.symbol ?? scope(row.scope)}
                        </p>
                        <p>
                          {G.polarity}: {tone(row.polarity)} · {G.severity}: {status(row.severity)}
                        </p>
                        {(alert.level || alert.distance) && (
                          <p>
                            {alert.level && (
                              <>
                                {G.alertLevel}: {alert.level}
                              </>
                            )}{" "}
                            {alert.distance && (
                              <>
                                {G.alertDistance}: {alert.distance.text}
                              </>
                            )}
                          </p>
                        )}
                        <p>
                          {G.current}:{" "}
                          {row.lastValue === null ? (
                            "-"
                          ) : row.kind === "volume_spike" ? (
                            <>
                              <Amount value={D(String(row.lastValue))} fractionDigits={1} /> ×
                            </>
                          ) : row.unit === "ratio" ? (
                            <Percent value={D(String(row.lastValue))} />
                          ) : row.unit === "price" && row.instrumentDetail !== null ? (
                            <Money
                              value={
                                new MoneyValue(
                                  D(String(row.lastValue)),
                                  row.instrumentDetail.currency,
                                )
                              }
                            />
                          ) : (
                            <Amount value={D(String(row.lastValue))} fractionDigits={2} />
                          )}{" "}
                          · {G.status}: {status(row.signal?.status ?? row.status)}
                        </p>
                        {row.stateUnavailable && <p>{G.unavailable}</p>}
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className={button}
                          onClick={() => state.setEditingAlert(row.gid)}
                        >
                          {G.alertsEdit}
                        </button>
                        <button
                          type="button"
                          className={button}
                          onClick={() =>
                            void state.setAlertState(
                              row.gid,
                              row.status === "muted" ? "active" : "muted",
                            )
                          }
                        >
                          {row.status === "muted" ? G.unmute : G.mute}
                        </button>
                        <button
                          type="button"
                          className={button}
                          onClick={() => void state.removeAlert(row.gid)}
                        >
                          {G.remove}
                        </button>
                      </div>
                    </div>
                    <DateText value={date(row.lastCheckedAt)} />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
      <AlertHistory state={state} />
    </>
  );
}
function AlertHistory({ state }: { state: SignalsScreenState }) {
  const ref = useRef<HTMLDivElement>(null);
  const rows = state.history;
  const virtual = useVirtualRows({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 62,
    getItemKey: (index) => rows[index]?.gid ?? index,
    overscan: 5,
  });
  return (
    <section className={card}>
      <header className="flex justify-between">
        <h2>{G.history}</h2>
        <button
          type="button"
          className={button}
          disabled={state.privacy || state.data === null}
          onClick={state.exportHistory}
        >
          {G.csv}
        </button>
      </header>
      {rows.length === 0 ? (
        <p>{G.noRows}</p>
      ) : (
        <div ref={ref} className="max-h-96 overflow-auto">
          <div className="relative" style={{ height: virtual.totalSize }}>
            {virtual.items.map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              const observed = alertSignalObserved(row);
              return (
                <div
                  key={item.key}
                  ref={virtual.measureElement}
                  data-index={item.index}
                  className="absolute left-0 top-0 flex w-full flex-wrap justify-between gap-2 border-b border-border p-2"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <DateText value={date(row.firstSeenAt)} />
                  <span>{row.message}</span>
                  <span>
                    {G.csvValue}:{" "}
                    {observed === null ? (
                      "-"
                    ) : observed.unit === "ratio" ? (
                      <Percent value={D(observed.value)} />
                    ) : observed.unit === "multiple" ? (
                      <>
                        <Amount value={D(observed.value)} fractionDigits={1} /> ×
                      </>
                    ) : observed.currency ? (
                      <Money value={new MoneyValue(D(observed.value), observed.currency)} />
                    ) : (
                      <Amount value={D(observed.value)} />
                    )}
                  </span>
                  <span>{status(row.status)}</span>
                  <span>
                    {row.decisions.at(-1)?.action
                      ? decision(row.decisions.at(-1)?.action ?? "")
                      : "-"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
function WatchlistPage({ state }: { state: SignalsScreenState }) {
  const [active, setActive] = useState(0);
  const hits = state.watchHits;
  const ref = useRef<HTMLDivElement>(null);
  const rows = state.data?.context.status === "ready" ? state.data.context.watchlist : [];
  const virtual = useVirtualRows({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 76,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 5,
  });
  return (
    <>
      <section className={card}>
        <label>
          {G.search}
          <input
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls="signals-search-results"
            value={state.searchText}
            onChange={(event) => {
              state.setSearchText(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") state.setSearchText("");
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive(Math.min(active + 1, hits.length - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive(Math.max(active - 1, 0));
              }
              if (event.key === "Enter" && hits[active]) {
                state.chooseWatchHit(hits[active]);
              }
            }}
            className="block w-full rounded-sm border border-border bg-surface p-2"
          />
        </label>
        {state.searchBusy && <p role="status">{G.search}</p>}
        {state.searchResult?.remote_status === "unavailable" && <p>{G.remoteUnavailable}</p>}
        <div id="signals-search-results" role="listbox">
          {hits.map((hit, index) => (
            <button
              key={hit.key}
              type="button"
              role="option"
              aria-selected={index === active}
              className={`${button} block w-full text-left`}
              onClick={() => state.chooseWatchHit(hit)}
            >
              {hit.symbol} · {hit.name} · {status(hit.state)} ·{" "}
              {hit.state === "watched" ? G.opens : G.add}
            </button>
          ))}
        </div>
        {state.searchText.trim() && hits.length === 0 && (
          <button
            type="button"
            className={button}
            onClick={() => void state.addWatch({ kind: "text", text: state.searchText.trim() })}
          >
            {G.freeText}
          </button>
        )}
      </section>
      {state.removedWatch && (
        <button type="button" className={button} onClick={state.restoreWatch}>
          {G.undo}
        </button>
      )}
      <section className={card}>
        <h2>{G.watchlist}</h2>
        {state.data?.context.status !== "ready" ? (
          <p>{G.unavailable}</p>
        ) : rows.length === 0 ? (
          <p>{G.noRows}</p>
        ) : (
          <div ref={ref} className="max-h-96 overflow-auto">
            <div className="relative" style={{ height: virtual.totalSize }}>
              {virtual.items.map((item) => {
                const row = rows[item.index];
                if (!row) return null;
                const spark = state.watchSparks.get(row.id);
                const quoteCurrency = row.price?.currency || row.instrument?.currency || null;
                const marks = investmentMarks(row.instrument ?? {}, row.hints, row.held);
                return (
                  <div
                    key={item.key}
                    ref={virtual.measureElement}
                    data-index={item.index}
                    className="absolute left-0 top-0 grid w-full grid-cols-1 items-center gap-2 border-b border-border p-2 md:grid-cols-[minmax(7rem,1fr)_minmax(14rem,2fr)_minmax(16rem,2fr)_auto]"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <button
                      type="button"
                      onClick={() => state.options.onOpenAsset?.(row.instrument_id)}
                    >
                      {row.instrument?.symbol ?? row.instrument?.name ?? row.instrument_id}
                    </button>
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                      <span>{row.held ? G.heldInstrument : G.watched}</span>
                      <span>{row.source === "agent" ? G.agent : G.you}</span>
                      {row.note && <span>{row.note}</span>}
                      {row.tags.map((tag) => (
                        <span key={tag} className="rounded-sm border border-border px-1.5 py-0.5">
                          {tag}
                        </span>
                      ))}
                      {marks.map((mark) => (
                        <span key={mark} className="rounded-sm border border-border px-1.5 py-0.5">
                          {mark}
                        </span>
                      ))}
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                      {row.price ? (
                        <>
                          <span>
                            {G.lastQuote}:{" "}
                            {quoteCurrency ? (
                              <Money
                                value={new MoneyValue(D(String(row.price.close)), quoteCurrency)}
                              />
                            ) : (
                              <Amount value={D(String(row.price.close))} />
                            )}
                          </span>
                          <DateText value={row.price.date} />
                          {row.price.stale && <span>{G.stalePrice}</span>}
                          <span>
                            {G.changeDay}:{" "}
                            <Percent
                              value={
                                row.price.change_1d === null ? null : D(String(row.price.change_1d))
                              }
                            />
                          </span>
                          <span>
                            {G.changeMonth}:{" "}
                            <Percent
                              value={
                                row.price.change_1m === null ? null : D(String(row.price.change_1m))
                              }
                            />
                          </span>
                        </>
                      ) : (
                        <span>{G.noPrice}</span>
                      )}
                      {spark && <Sparkline values={spark} label={G.spark} />}
                      <span>
                        {G.liveAlerts}:{" "}
                        <Amount value={D(String(row.alerts.live))} fractionDigits={0} />
                      </span>
                    </div>
                    <button
                      type="button"
                      className={`${button} justify-self-end`}
                      onClick={() => state.removeWatchByInstrument(row.instrument_id)}
                    >
                      {G.remove}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
function JournalPage({ state }: { state: SignalsScreenState }) {
  const rows = state.journalRows;
  const ref = useRef<HTMLDivElement>(null);
  const virtual = useVirtualRows({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 76,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 5,
  });
  return (
    <section className={card}>
      <div className="flex flex-wrap gap-2">
        <select
          className={button}
          aria-label={G.all}
          value={state.journalFilter}
          onChange={(event) =>
            state.setJournalFilter(event.target.value as typeof state.journalFilter)
          }
        >
          <option value="all">{G.all}</option>
          <option value="decisions">{G.filterDecisions}</option>
          <option value="signals">{G.filterSignals}</option>
        </select>
        <select
          className={button}
          aria-label={G.instrument}
          value={state.journalInstrument}
          onChange={(event) => state.setJournalInstrument(event.target.value)}
        >
          <option value="">{G.all}</option>
          {state.data?.instruments.map((row) => (
            <option key={row.id} value={row.id}>
              {row.symbol ?? row.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-4 py-3">
        <span>
          {G.filterDecisions}:{" "}
          <Amount value={D(String(state.journalDecisions.length))} fractionDigits={0} />
        </span>
        <span>
          {G.filterSignals}: <Amount value={D(String(state.journal.length))} fractionDigits={0} />
        </span>
      </div>
      {rows.length === 0 ? (
        <p>{G.noRows}</p>
      ) : (
        <div ref={ref} className="max-h-96 overflow-auto">
          <div className="relative" style={{ height: virtual.totalSize }}>
            {virtual.items.map((item) => {
              const entry = rows[item.index];
              if (!entry) return null;
              return (
                <div
                  key={item.key}
                  ref={virtual.measureElement}
                  data-index={item.index}
                  className="absolute left-0 top-0 w-full border-b border-border p-2"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {entry.kind === "year" ? (
                    <div className="flex flex-wrap gap-3">
                      <strong>{entry.year}</strong>
                      <span>
                        {G.filterDecisions}:{" "}
                        <Amount value={D(String(entry.decisions))} fractionDigits={0} />
                      </span>
                      <span>
                        {G.filterSignals}:{" "}
                        <Amount value={D(String(entry.signals))} fractionDigits={0} />
                      </span>
                      {entry.actions.map(([action, count]) => (
                        <span key={action}>
                          {decision(action)}: <Amount value={D(String(count))} fractionDigits={0} />
                        </span>
                      ))}
                    </div>
                  ) : entry.kind === "month" ? (
                    <h3>{entry.month}</h3>
                  ) : entry.kind === "decision" ? (
                    <>
                      <DateText value={date(entry.at)} /> {G.filterDecisions}:{" "}
                      {decision(entry.row.action)} {entry.row.reason ?? ""} · {G.covered}:{" "}
                      <Amount value={D(String(entry.row.signals.length))} fractionDigits={0} />
                      {entry.row.instrument && (
                        <button
                          type="button"
                          className={button}
                          onClick={() => {
                            if (entry.row.instrument)
                              state.options.onOpenAsset?.(entry.row.instrument);
                          }}
                        >
                          {G.opens}
                        </button>
                      )}
                      {state.undoableDecisionIds.has(entry.row.gid) && (
                        <button
                          type="button"
                          className={button}
                          onClick={() => void state.undoOne(entry.row.gid)}
                        >
                          {G.undo}
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <DateText value={date(entry.at)} /> {G.filterSignals}: {entry.row.message}{" "}
                      {status(entry.row.status)} ·{" "}
                      {entry.row.decisions.length
                        ? decision(entry.row.decisions.at(-1)?.action ?? "")
                        : G.noDecision}
                      {entry.row.instrument && (
                        <button
                          type="button"
                          className={button}
                          onClick={() => {
                            if (entry.row.instrument)
                              state.options.onOpenAsset?.(entry.row.instrument);
                          }}
                        >
                          {G.opens}
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
