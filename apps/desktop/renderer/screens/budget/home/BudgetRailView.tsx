// The budget screen's rail (design/desktop/budget/one-screen.html, right column): Subscriptions (the monthly
// total, the next charges, the rest and the ended ones folded), "Po zamknięciu miesiąca" (the amount to invest,
// the contribution plan, the emergency cushion with its inline form) and "Bez kategorii" (merchants the
// categories drawer reviews). Pure.
import { S as MC } from "@cashu/i18n/budget/MonthClose.strings";
import { C } from "@cashu/i18n/core/common.strings";
import { Button, ControlRow, Notice, Seg, Select, Switch, TextField, Widget } from "@cashu/ui";
import type { ReactNode } from "react";
import type {
  AfterMonthState,
  CushionFormState,
  SubRowState,
  SubscriptionsState,
  UncategorizedState,
} from "./budgetHomeState.js";
import { QuietLink, rowDelay, rowIn } from "./tileParts.js";

const UNKNOWN = "?";

/** The rail's big figure ("439,69 zł" with a small unit after it). */
function Big({ children, unit }: { children: ReactNode; unit?: string | undefined }) {
  return (
    <div className="mt-1 whitespace-nowrap text-4xl font-bold leading-hero tracking-dense tabular-nums">
      {children}
      {unit && (
        <small className="ml-1 text-sm font-medium tracking-normal text-fg-muted">{unit}</small>
      )}
    </div>
  );
}

/** A rail row: a 30px initial tile, name over a quiet line, the value over its own quiet line. */
function RailItem({
  initial,
  name,
  line,
  value,
  valueLine,
  accent = false,
  dim = false,
  quietInitial = false,
  k,
}: {
  initial: string;
  name: string;
  line: string;
  value: string;
  valueLine?: string | null | undefined;
  accent?: boolean;
  dim?: boolean;
  quietInitial?: boolean;
  k: number;
}) {
  return (
    <div
      className={`grid grid-cols-[--spacing(7.5)_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-border py-2 first:border-t-0 ${dim ? "opacity-50" : ""} ${rowIn}`}
      style={rowDelay(k)}
    >
      <span
        aria-hidden
        className={`tile-sub grid size-7.5 place-items-center rounded-md text-xs font-bold ${quietInitial ? "text-fg-muted" : "text-fg"}`}
      >
        {initial}
      </span>
      <span className="min-w-0">
        <b className="block truncate font-demi">{name}</b>
        <span className="block text-2xs-plus text-fg-muted">{line}</span>
      </span>
      <span className="text-right">
        <b className="block whitespace-nowrap font-heavy tabular-nums">{value}</b>
        {valueLine && (
          <span className={`block text-2xs-plus ${accent ? "text-accent" : "text-fg-muted"}`}>
            {valueLine}
          </span>
        )}
      </span>
    </div>
  );
}

const subItem = (s: SubRowState, k: number) => (
  <RailItem
    key={s.key}
    k={k}
    initial={s.initial}
    name={s.payee}
    line={s.cadence}
    value={s.amount}
    valueLine={s.when}
    accent={s.soon}
    dim={s.when === null}
  />
);

const label = "mt-4 mb-1 flex items-center text-xs text-fg-muted";
const noteTone = {
  positive: "text-positive",
  warning: "text-warning",
  muted: "text-fg-muted",
} as const;

export function SubscriptionsTile({ subs }: { subs: SubscriptionsState }) {
  return (
    <Widget
      title={subs.title}
      variant="quiet"
      layered
      tight
      controls={
        subs.count ? <span className="text-sm text-fg-muted">{subs.count}</span> : undefined
      }
    >
      {subs.empty ? (
        <div className="text-sm text-fg-muted">{subs.empty}</div>
      ) : (
        <>
          {subs.monthly && <Big unit={subs.monthly.unit}>{subs.monthly.value}</Big>}
          {subs.extra.map((line) => (
            <div key={line} className="text-xs text-fg-secondary tabular-nums">
              {line}
            </div>
          ))}
          {subs.sub && <div className="mt-0.75 text-xs text-fg-muted">{subs.sub}</div>}
          {subs.next.length > 0 && <div className={label}>{subs.nextLabel}</div>}
          {subs.next.map(subItem)}
          <div
            inert={!subs.open}
            className={`grid transition-[grid-template-rows] duration-260 ease-tile motion-reduce:transition-none ${subs.open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
          >
            <div className="min-h-0 overflow-hidden">
              {subs.rest.map(subItem)}
              {subs.ended.length > 0 && <div className={`${label} mt-2.5`}>{subs.endedLabel}</div>}
              {subs.ended.map(subItem)}
            </div>
          </div>
          {subs.toggle && (
            <div className="mt-2">
              <QuietLink expanded={subs.open} onPress={subs.toggle.onPress}>
                {subs.toggle.label}
              </QuietLink>
            </div>
          )}
        </>
      )}
    </Widget>
  );
}

/** One key / value line of the "after the month" tile, under a hairline, with a quiet note below. */
function KeyValue({ k, v, note }: { k: ReactNode; v: ReactNode; note: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t border-border py-3">
      <span className="font-medium text-fg-secondary">{k}</span>
      <span className="whitespace-nowrap text-right font-heavy tabular-nums">{v}</span>
      <span className="col-span-2 text-2xs-plus text-fg-muted">{note}</span>
    </div>
  );
}

export function AfterMonthTile({ after }: { after: AfterMonthState }) {
  return (
    <Widget title={after.title} variant="quiet" layered tight still={after.form !== null}>
      {after.amount !== null ? (
        <>
          <Big>{after.amount}</Big>
          {after.sub && <div className="mt-0.75 text-xs text-fg-muted">{after.sub}</div>}
        </>
      ) : (
        <div className="text-sm text-fg-muted">{after.empty}</div>
      )}
      <div className="mt-3">
        {after.plan && (
          <KeyValue
            k={after.plan.label}
            v={after.plan.value}
            note={<span className={noteTone[after.plan.tone]}>{after.plan.note}</span>}
          />
        )}
        <KeyValue
          k={after.cushion.label}
          v={
            <Button
              size="sm"
              disabled={after.cushion.disabled}
              expanded={after.cushion.open}
              onPress={after.cushion.toggle}
            >
              {after.cushion.button}
            </Button>
          }
          note={<span title={after.cushion.title}>{after.cushion.text}</span>}
        />
      </div>
      {after.form && <CushionForm form={after.form} />}
    </Widget>
  );
}

/** The cushion form (the month close's inline form, every field kept): cushion first, target as an amount or
 * months of spending, its currency, the monthly top-up cap and the accounts that count. */
function CushionForm({ form }: { form: CushionFormState }) {
  const { draft, set } = form;
  return (
    <div className="mt-1 grid gap-3 border-t border-border pt-3 motion-safe:animate-[toast-in_0.17s_var(--ease-tile)]">
      <ControlRow className="mb-0">
        <Switch
          on={draft.enabled}
          onChange={(v) => set({ enabled: v })}
          label={MC.cushionFirst}
          title={MC.cushionFirstTitle}
        />
        <span className="text-sm" title={MC.cushionFirstTitle}>
          {MC.cushionFirst}
        </span>
      </ControlRow>
      {draft.enabled && (
        <>
          <div className="grid gap-1 text-xs text-fg-muted">
            <span>{MC.target}</span>
            <Seg<"amount" | "months">
              quiet
              label={MC.target}
              className="w-max"
              items={[
                [MC.amount, "amount"],
                [MC.monthsOfSpending, "months"],
              ]}
              value={draft.mode}
              onChange={(m) => set({ mode: m })}
            />
          </div>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2.5">
            {draft.mode === "amount" ? (
              <TextField
                className="w-32.5"
                label={MC.amountIn(draft.currency)}
                inputMode="decimal"
                value={draft.amount}
                onChange={(v) => set({ amount: v })}
              />
            ) : (
              <TextField
                className="w-32.5"
                label={MC.months}
                inputMode="numeric"
                value={draft.months}
                onChange={(v) => set({ months: v })}
              />
            )}
            {form.currencies.length > 1 && (
              <Select
                label={MC.currency}
                value={draft.currency}
                options={form.currencies.map((c) => ({ value: c, label: c }))}
                onChange={(v) => set({ currency: v, accountIds: [] })}
              />
            )}
            <TextField
              className="w-32.5"
              label={MC.maxTopUp}
              inputMode="decimal"
              value={draft.monthlyMax}
              onChange={(v) => set({ monthlyMax: v })}
            />
          </div>
          <div className="grid gap-1">
            <span
              className="text-xs text-fg-muted"
              title={MC.accountsTitle(draft.currency, MC.cushionLevel)}
            >
              {MC.accounts}
            </span>
            {form.accounts.length ? (
              <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-sm">
                {form.accounts.map((a) => (
                  <label key={a.id} className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={draft.accountIds.includes(a.id)}
                      onChange={(e) =>
                        set({
                          accountIds: e.target.checked
                            ? [...draft.accountIds, a.id]
                            : draft.accountIds.filter((i) => i !== a.id),
                        })
                      }
                    />
                    {a.name}
                  </label>
                ))}
              </div>
            ) : (
              <span className="text-xs text-fg-muted">{MC.noAccounts(draft.currency)}</span>
            )}
          </div>
        </>
      )}
      {form.error && <Notice tone="negative">{form.error}</Notice>}
      <ControlRow className="mb-0 justify-end">
        <Button disabled={form.busy} onPress={form.cancel}>
          {C.cancel}
        </Button>
        <Button variant="primary" disabled={form.busy} onPress={form.save}>
          {C.save}
        </Button>
      </ControlRow>
    </div>
  );
}

export function UncategorizedTile({ uncat }: { uncat: UncategorizedState }) {
  return (
    <Widget
      title={uncat.title}
      variant="quiet"
      layered
      tight
      tags={<span aria-hidden className="size-1.5 rounded-full bg-warning" />}
      controls={
        <Button size="sm" onPress={uncat.review.onPress}>
          {uncat.review.label}
        </Button>
      }
    >
      <div className="mb-2 text-xs text-fg-muted">{uncat.summary}</div>
      {uncat.rows.map((r, k) => (
        <RailItem
          key={r.key}
          k={k}
          initial={UNKNOWN}
          quietInitial
          name={r.name}
          line={r.count}
          value={r.total}
        />
      ))}
    </Widget>
  );
}
