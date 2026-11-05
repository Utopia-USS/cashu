// "Zamknięcie miesiąca" (ab24ab6 modules/budget/MonthClose.tsx + budget.css): the month stepper head, the four
// figures, the top categories line with the full list, the cushion / plan / other currencies strip and the
// inline cushion form.
import { S } from "@cashu/i18n/budget/MonthClose.strings";
import { C } from "@cashu/i18n/core/common.strings";
import {
  Button,
  ChartCard,
  ControlRow,
  Fact,
  LegendRow,
  Notice,
  PeriodStepper,
  Seg,
  Select,
  SumStrip,
  type SumStripItem,
  Switch,
  Tag,
  TextField,
} from "@cashu/ui";
import type { MonthCloseState } from "./useMonthClose.js";

const DOT = " · ";
const SPACE = " ";

function CushionForm({ form }: { form: NonNullable<MonthCloseState["form"]> }) {
  const { draft, set } = form;
  return (
    <div className="mt-3 border-t border-border pt-3">
      <ControlRow className="mb-2">
        <Switch
          on={draft.enabled}
          onChange={(v) => set({ enabled: v })}
          label={S.cushionFirst}
          title={S.cushionFirstTitle}
        />
        <span className="text-sm" title={S.cushionFirstTitle}>
          {S.cushionFirst}
        </span>
      </ControlRow>
      {draft.enabled && (
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2.5">
          <div className="mb-2 grid gap-1 text-xs text-fg-muted">
            <span>{S.target}</span>
            <Seg<"amount" | "months">
              label={S.target}
              items={[
                [S.amount, "amount"],
                [S.monthsOfSpending, "months"],
              ]}
              value={draft.mode}
              onChange={(m) => set({ mode: m })}
            />
          </div>
          {draft.mode === "amount" ? (
            <TextField
              className="mb-2 w-32.5"
              label={S.amountIn(draft.currency)}
              inputMode="decimal"
              value={draft.amount}
              onChange={(v) => set({ amount: v })}
            />
          ) : (
            <TextField
              className="mb-2 w-20"
              label={S.months}
              inputMode="numeric"
              value={draft.months}
              onChange={(v) => set({ months: v })}
            />
          )}
          {form.currencies.length > 1 && (
            <Select
              className="mb-2"
              label={S.currency}
              value={draft.currency}
              options={form.currencies.map((c) => ({ value: c, label: c }))}
              onChange={(v) => set({ currency: v, accountIds: [] })}
            />
          )}
          <TextField
            className="mb-2 w-32.5"
            label={S.maxTopUp}
            inputMode="decimal"
            value={draft.monthlyMax}
            onChange={(v) => set({ monthlyMax: v })}
          />
        </div>
      )}
      {draft.enabled && (
        <div className="mb-2 grid gap-1">
          <span
            className="text-xs text-fg-muted"
            title={S.accountsTitle(draft.currency, S.cushionLevel)}
          >
            {S.accounts}
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
            <span className="text-xs text-fg-muted">{S.noAccounts(draft.currency)}</span>
          )}
        </div>
      )}
      {form.error && <Notice tone="negative">{form.error}</Notice>}
      <ControlRow className="mb-0">
        <Button variant="primary" disabled={form.busy} onPress={form.save}>
          {C.save}
        </Button>
        <Button disabled={form.busy} onPress={form.cancel}>
          {C.cancel}
        </Button>
      </ControlRow>
    </div>
  );
}

export function MonthCloseView({ state }: { state: MonthCloseState }) {
  const f = state.figures;
  const strip: SumStripItem[] = [
    {
      key: "cushion",
      label: S.cushion,
      value: state.cushion,
      weight: "demi",
      ...(state.cushionTitle ? { title: state.cushionTitle } : {}),
      after: (
        <Button
          size="sm"
          className="ml-1.5"
          disabled={state.editDisabled}
          expanded={state.form !== null}
          onPress={state.toggleForm}
        >
          {state.form ? C.close : S.set}
        </Button>
      ),
    },
    ...(state.plan
      ? [
          {
            key: "plan",
            label: S.plan,
            value: state.plan.text,
            weight: "demi" as const,
            after: state.plan.tag ? (
              <>
                {SPACE}
                <Tag tone={state.plan.tag.tone}>{state.plan.tag.text}</Tag>
              </>
            ) : undefined,
          },
        ]
      : []),
    ...(state.others
      ? [{ key: "others", label: S.otherCurrencies, value: state.others, weight: "demi" as const }]
      : []),
  ];
  return (
    <ChartCard
      label={S.title}
      title={S.title}
      tags={state.inProgress ? <Tag tone="warning">{S.inProgress}</Tag> : undefined}
      controls={
        <PeriodStepper
          label={state.month}
          prevDisabled={state.prevDisabled}
          nextDisabled={state.nextDisabled}
          prevLabel={S.prevMonth}
          nextLabel={S.nextMonth}
          onStep={state.step}
        />
      }
    >
      {!f ? (
        <div className="text-sm text-fg-muted">{state.noTransactions}</div>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(--spacing(37.5),1fr))] gap-3">
            <Fact size="xl" label={S.income} value={f.income} tone="positive" />
            <Fact size="xl" label={S.expenses} value={f.spending} tone="negative" />
            <Fact
              size="xl"
              label={S.surplus}
              value={f.surplus}
              tone={f.surplusNegative ? "negative" : "positive"}
            />
            <Fact
              size="xl"
              label={S.toInvest}
              value={f.toInvest}
              tone="accent"
              detail={f.toInvestHint}
            />
          </div>
          {state.cats.length > 0 && (
            <div className="mt-3 text-sm text-fg-muted">
              {S.top}
              {state.top.map((c, i) => (
                <span key={c.key}>
                  {i ? DOT : ""}
                  {c.label}
                  {SPACE}
                  <b className="font-demi tabular-nums text-fg">{c.amount}</b>
                </span>
              ))}
              {state.cats.length > state.top.length && (
                <>
                  {DOT}
                  <button
                    type="button"
                    className="cursor-pointer border-0 bg-transparent p-0 text-accent"
                    aria-expanded={state.allCats}
                    onClick={state.toggleCats}
                  >
                    {state.allCats ? S.collapse : S.all(state.cats.length)}
                  </button>
                </>
              )}
              {state.allCats && (
                <div className="mt-2 max-w-130">
                  {state.cats.map((c) => (
                    <LegendRow key={c.key} label={c.label} amount={c.amount} share={c.share} />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
      <SumStrip items={strip} />
      {state.form && <CushionForm form={state.form} />}
    </ChartCard>
  );
}
