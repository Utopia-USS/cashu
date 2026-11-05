import { D, Money as MoneyValue } from "@cashu/domain";
import {
  BarChart,
  Button,
  Card,
  DateText,
  Donut,
  Modal,
  Money,
  Percent,
  Select,
  TextField,
  VirtualList,
} from "@cashu/ui";
import type { ReactNode } from "react";
import { B } from "./Budget.strings.js";
import type { BudgetScreenState } from "./useBudgetScreen.js";

// Virtualization is presentation only; domain rows and actions arrive from the screen hook.
function WindowRows<T>({
  rows,
  rowKey,
  children,
}: {
  rows: readonly T[];
  rowKey(row: T): string;
  children(row: T): ReactNode;
}) {
  return (
    <VirtualList
      items={rows}
      getKey={rowKey}
      renderItem={children}
      label={B.transactions}
      estimateSize={88}
      rowClassName="border-b border-border py-3"
    />
  );
}

function CategoryChoice({
  state,
  value,
  onChange,
  drill = false,
}: {
  drill?: boolean;
  state: BudgetScreenState;
  value: string;
  onChange(category: string): void;
}) {
  return (
    <Select
      label={B.category}
      labelHidden
      value={value}
      disabled={state.busy}
      onChange={onChange}
      options={[
        { value: "", label: B.choose },
        ...state.categories
          .filter(
            (category) =>
              !drill || category.kind !== "transfer" || category.key === "cash_withdrawal",
          )
          .map((category) => ({ value: category.key, label: category.label })),
      ]}
    />
  );
}

function Spending({ state }: { state: BudgetScreenState }) {
  return (
    <>
      <Card label={B.expenses} padding="lg">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-title font-strong">{B.expenses}</h2>
          <Select
            label={B.range}
            inline
            value={state.mode}
            onChange={(value) => state.switchMode(value as typeof state.mode)}
            options={(["month", "quarter", "year", "all"] as const).map((mode) => ({
              value: mode,
              label: B[mode],
            }))}
          />
          {state.mode !== "all" && (
            <div className="flex items-center gap-3">
              <Button
                label={B.previous}
                disabled={state.anchor <= state.first}
                onPress={() => state.patch({ anchor: state.anchor - 1 })}
              >
                ‹
              </Button>
              <span>{state.periodLabel}</span>
              <Button
                label={B.next}
                disabled={state.anchor >= state.last}
                onPress={() => state.patch({ anchor: state.anchor + 1 })}
              >
                ›
              </Button>
            </div>
          )}
        </div>
        {state.display.length === 0 ? (
          <p>{B.empty}</p>
        ) : (
          <div className="grid items-center gap-6 md:grid-cols-2">
            <Donut
              label={B.expenses}
              size={280}
              segments={state.segments}
              onSegmentSelected={state.selectSlice}
            />
            <div>
              {state.display.map((row, index) => (
                <div key={row.category}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 border-b border-border py-3 text-left hover:bg-surface-sunken"
                    aria-expanded={row.category === "__rest__" ? state.restOpen : undefined}
                    onClick={() => state.selectSlice(index)}
                  >
                    <span>{row.label}</span>
                    <Money value={new MoneyValue(row.amount, state.currency)} />
                    <Percent
                      fractionDigits={0}
                      value={
                        state.total.amount.isZero() ? D("0") : row.amount.div(state.total.amount)
                      }
                    />
                  </button>
                  {row.category === "__rest__" &&
                    state.restOpen &&
                    state.small.map((small) => (
                      <button
                        type="button"
                        key={small.category}
                        className="flex w-full justify-between gap-3 py-2 pl-6 text-left"
                        onClick={() => state.patch({ drill: small.category })}
                      >
                        <span>{small.label}</span>
                        <Money value={new MoneyValue(small.amount, state.currency)} />
                      </button>
                    ))}
                </div>
              ))}
              <div className="mt-4 flex justify-between font-strong">
                <span>{B.total}</span>
                <Money value={state.total} />
              </div>
            </div>
          </div>
        )}
      </Card>
      {state.drillCategory !== null && (
        <Card label={B.transactions} padding="lg">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-title">
              {B.transactions}:{" "}
              {state.categories.find((c) => c.key === state.drillCategory)?.label ??
                state.drillCategory}
            </h2>
            <Select
              label={B.sort}
              inline
              value={state.sort}
              onChange={(value) => state.patch({ sort: value as "date" | "amount" })}
              options={[
                { value: "date", label: B.date },
                { value: "amount", label: B.amount },
              ]}
            />
            <Select
              label={B.order}
              inline
              value={state.order}
              onChange={(value) => state.patch({ order: value as "asc" | "desc" })}
              options={[
                { value: "desc", label: B.desc },
                { value: "asc", label: B.asc },
              ]}
            />
            <Button onPress={() => state.patch({ drill: undefined })}>{B.close}</Button>
          </div>
          {state.drill.length === 0 ? (
            <p>{B.empty}</p>
          ) : (
            <WindowRows rows={state.drill} rowKey={(row) => row.key}>
              {(row) => (
                <div className="grid items-center gap-3 md:grid-cols-4">
                  <DateText value={row.date} />
                  <div>
                    <p>{state.privacy ? "•••" : row.merchant}</p>
                    <p className="text-caption text-fg-muted">
                      {state.privacy ? "•••" : row.details}
                    </p>
                    <p className="text-caption">{state.privacy ? "•••" : row.account}</p>
                  </div>
                  <Money value={new MoneyValue(row.amount, row.currency)} />
                  <CategoryChoice
                    drill
                    state={state}
                    value={row.category ?? "other"}
                    onChange={(category) => void state.markCategory(row.key, category)}
                  />
                </div>
              )}
            </WindowRows>
          )}
          {state.offer !== null && (
            <Button
              className="mt-4"
              disabled={state.busy}
              onPress={() => {
                if (state.offer)
                  void state.markMerchant(state.offer.merchantKey, state.offer.category);
              }}
            >
              {state.privacy || state.offer === null
                ? B.applyMerchant
                : B.applyMerchantFor(state.offer.label)}
            </Button>
          )}
        </Card>
      )}
    </>
  );
}

function MonthClose({ state }: { state: BudgetScreenState }) {
  const close = state.close;
  if (!close)
    return (
      <Card padding="lg">
        <h2>{B.monthClose}</h2>
        <p>{B.unsupported}</p>
      </Card>
    );
  const selected = close.currencies.find((row) => row.currency === state.currency);
  return (
    <Card label={B.monthClose} padding="lg">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-title font-strong">{B.monthClose}</h2>
        {!close.complete && <span className="text-warning">{B.incomplete}</span>}
        <div className="flex items-center gap-3">
          <Button
            label={B.previous}
            disabled={close.firstMonth !== null && close.month <= close.firstMonth}
            onPress={() => state.shiftClose(-1)}
          >
            ‹
          </Button>
          <span>{close.month}</span>
          <Button
            label={B.next}
            disabled={close.lastMonth === null || close.month >= close.lastMonth}
            onPress={() => state.shiftClose(1)}
          >
            ›
          </Button>
        </div>
      </div>
      {selected ? (
        <>
          <dl className="grid gap-4 sm:grid-cols-4">
            {(
              [
                [B.income, selected.income],
                [B.expense, selected.spending],
                [B.surplus, selected.surplus],
                [B.suggested, selected.suggestedTransfer],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="text-caption text-fg-muted">{label}</dt>
                <dd>
                  <Money
                    value={value === null ? null : new MoneyValue(value, selected.currency)}
                    size="title"
                  />
                </dd>
              </div>
            ))}
          </dl>
          <div className="mt-4 flex flex-wrap gap-3">
            {selected.spendingByCategory
              .slice(0, state.allCategories ? undefined : 3)
              .map((category) => (
                <span key={category.category}>
                  {category.label}{" "}
                  <Money value={new MoneyValue(category.amount, selected.currency)} />
                </span>
              ))}
            {selected.spendingByCategory.length > 3 && (
              <Button
                expanded={state.allCategories}
                onPress={() => state.setAllCategories(!state.allCategories)}
              >
                {B.allCategories}
              </Button>
            )}
          </div>
        </>
      ) : (
        <p>{B.empty}</p>
      )}
      <div className="mt-4 border-t border-border pt-4">
        <p>
          {B.cushion}:{" "}
          {state.settingsUnavailable ? (
            B.unsupported
          ) : close.cushion ? (
            <>
              <span title={B.level}>
                <Money value={new MoneyValue(close.cushion.balance, close.cushion.currency)} />
              </span>{" "}
              /{" "}
              <Money
                value={
                  close.cushion.target === null
                    ? null
                    : new MoneyValue(close.cushion.target, close.cushion.currency)
                }
              />{" "}
              · {B.topUp}{" "}
              <Money value={new MoneyValue(close.cushion.topUp, close.cushion.currency)} />
            </>
          ) : (
            B.cushionOff
          )}
        </p>
        {close.cushion && close.cushion.target === null && (
          <p className="text-caption text-fg-muted">{B.noHistory}</p>
        )}
        <Button className="mt-3" disabled={state.privacy} onPress={state.openCushion}>
          {B.edit}
        </Button>
      </div>
      {state.strategyUnavailable ? (
        <p className="mt-3 text-fg-muted">{B.strategyUnavailable}</p>
      ) : (
        close.investing &&
        (close.investing.planned ? (
          <p className="mt-3">
            {B.planned}:{" "}
            <Money
              value={
                new MoneyValue(close.investing.planned.amount, close.investing.planned.currency)
              }
            />{" "}
            {close.investing.comparison && (
              <>
                {B.difference}:{" "}
                <Money
                  value={
                    new MoneyValue(
                      close.investing.comparison.difference,
                      close.investing.comparison.currency,
                    )
                  }
                />
              </>
            )}
          </p>
        ) : (
          <p className="mt-3">
            {close.investing.strategyState === "missing"
              ? B.strategyMissing
              : close.investing.strategyState === "invalid"
                ? B.strategyInvalid
                : B.noPlan}
          </p>
        ))
      )}
      {close.currencies.filter((row) => row.currency !== state.currency).length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3">
          {B.otherCurrencies}:{" "}
          {close.currencies
            .filter((row) => row.currency !== state.currency)
            .map((row) => (
              <Money key={row.currency} value={new MoneyValue(row.surplus, row.currency)} />
            ))}
        </div>
      )}
    </Card>
  );
}

function CushionForm({ state }: { state: BudgetScreenState }) {
  return (
    <Modal
      label={B.cushion}
      onClose={state.closeCushion}
      placement="center"
      closeOnBackdrop={false}
    >
      <h2 className="text-title">{B.cushion}</h2>
      {state.message && <p role="status">{state.message}</p>}
      <form
        className="mt-4 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void state.form.handleSubmit();
        }}
      >
        <state.form.Field name="enabled">
          {(field) => (
            <label>
              <input
                type="checkbox"
                checked={field.state.value}
                onChange={(event) => field.handleChange(event.target.checked)}
              />{" "}
              {B.cushion}
            </label>
          )}
        </state.form.Field>
        <state.form.Field name="currency">
          {(field) => (
            <Select
              label={B.currency}
              inline
              value={field.state.value}
              onChange={(value) => {
                field.handleChange(value);
                state.form.setFieldValue("accounts", []);
              }}
              options={[...new Set([...state.codes, field.state.value])].map((code) => ({
                value: code,
                label: code,
              }))}
            />
          )}
        </state.form.Field>
        <state.form.Field name="targetMode">
          {(field) => (
            <Select
              label={B.target}
              inline
              value={field.state.value}
              onChange={(value) => field.handleChange(value as "amount" | "months")}
              options={[
                { value: "amount", label: B.amount },
                { value: "months", label: B.months },
              ]}
            />
          )}
        </state.form.Field>
        <state.form.Subscribe selector={(state) => state.values.targetMode}>
          {(mode) =>
            mode === "amount" ? (
              <state.form.Field name="targetAmount">
                {(field) => (
                  <TextField
                    label={B.target}
                    inline
                    value={field.state.value}
                    inputMode="decimal"
                    onChange={field.handleChange}
                  />
                )}
              </state.form.Field>
            ) : (
              <state.form.Field name="targetMonths">
                {(field) => (
                  <TextField
                    label={B.months}
                    inline
                    type="number"
                    min="1"
                    max="36"
                    value={String(field.state.value ?? "")}
                    onChange={(value) => field.handleChange(value === "" ? null : Number(value))}
                  />
                )}
              </state.form.Field>
            )
          }
        </state.form.Subscribe>
        <state.form.Field name="monthlyMax">
          {(field) => (
            <TextField
              label={B.maximum}
              inline
              value={field.state.value}
              inputMode="decimal"
              onChange={field.handleChange}
            />
          )}
        </state.form.Field>
        <state.form.Subscribe selector={(state) => state.values.currency}>
          {(currency) => (
            <state.form.Field name="accounts">
              {(field) => (
                <fieldset>
                  <legend>{B.accounts}</legend>
                  {state.accounts
                    .filter((account) => account.currency === currency)
                    .map((account) => (
                      <label key={account.gid} className="mr-4 inline-flex gap-2">
                        <input
                          type="checkbox"
                          checked={field.state.value.includes(account.gid)}
                          onChange={(event) =>
                            field.handleChange(
                              event.target.checked
                                ? [...field.state.value, account.gid]
                                : field.state.value.filter((id) => id !== account.gid),
                            )
                          }
                        />
                        {state.privacy ? "•••" : account.name}
                      </label>
                    ))}
                </fieldset>
              )}
            </state.form.Field>
          )}
        </state.form.Subscribe>
        <state.form.Subscribe selector={(state) => state.errors}>
          {(errors) => (errors.length > 0 ? <p role="alert">{B.refused}</p> : null)}
        </state.form.Subscribe>
        <div className="flex gap-3">
          <Button type="submit" variant="primary" disabled={state.busy}>
            {B.save}
          </Button>
          <Button onPress={state.closeCushion}>{B.close}</Button>
        </div>
      </form>
    </Modal>
  );
}

export interface BudgetViewProps {
  state: BudgetScreenState;
  onTabPicked(tab: BudgetScreenState["tab"]): void;
}
/** Three budget tabs over live, vault-scoped native queries and commands. */
export function BudgetView({ state, onTabPicked }: BudgetViewProps) {
  return (
    <main
      className="mx-auto flex max-w-6xl flex-col gap-6 p-6"
      aria-label={B[state.tab === "subs" ? "subscriptions" : state.tab]}
    >
      <h1 className="text-headline font-strong">
        {B[state.tab === "subs" ? "subscriptions" : state.tab]}
      </h1>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label={B.range} className="flex gap-3">
          {(["expenses", "flows", "subs"] as const).map((tab) => (
            <Button
              key={tab}
              className={`${state.tab === tab ? "bg-accent-muted text-accent" : ""}`}
              current={state.tab === tab ? "page" : undefined}
              onPress={() => onTabPicked(tab)}
            >
              {B[tab === "subs" ? "subscriptions" : tab]}
            </Button>
          ))}
        </nav>
        <div className="flex flex-wrap gap-3">
          {state.codes.length > 1 && state.tab !== "subs" && (
            <Select
              label={B.currency}
              inline
              value={state.currency}
              onChange={(value) => state.patch({ currency: value })}
              options={state.codes.map((code) => ({ value: code, label: code }))}
            />
          )}
          <Button onPress={state.openCategories}>{B.uncategorized}</Button>
          <Button onPress={() => state.setImportOpen(true)}>{B.import}</Button>
          <Button title={B.syncUnavailable} onPress={() => state.setMessage(B.syncUnavailable)}>
            {B.sync}
          </Button>
        </div>
      </div>
      {state.message !== null && (
        <div role="status" className="rounded-md bg-info-bg p-3">
          {state.message}
        </div>
      )}
      {state.tab === "expenses" && <Spending state={state} />}
      {state.tab === "flows" && (
        <>
          <MonthClose state={state} />
          <Card label={B.flows} padding="lg">
            <div className="mb-4 flex flex-wrap justify-between gap-3">
              <h2 className="text-title">{B.flows}</h2>
              <Select
                label={B.range}
                inline
                value={state.gran}
                onChange={(value) =>
                  state.patch({ gran: value as typeof state.gran, range: undefined })
                }
                options={(["monthly", "quarterly", "yearly"] as const).map((gran) => ({
                  value: gran,
                  label: B[gran],
                }))}
              />
              <Select
                label={B.range}
                labelHidden
                value={String(state.range)}
                onChange={(value) => state.patch({ range: Number(value) })}
                options={state.ranges.map((range) => ({
                  value: String(range),
                  label: range === 0 ? B.all : String(range),
                }))}
              />
            </div>
            {state.flowRows.length === 0 ? (
              <p>{B.empty}</p>
            ) : (
              <BarChart
                label={B.flows}
                values={[]}
                labels={state.flowRows.map((row) => row.label)}
                series={[
                  {
                    name: B.income,
                    values: state.flowRows.map((row) => row.income.toFloat()),
                    color: 1,
                  },
                  {
                    name: B.expense,
                    values: state.flowRows.map((row) => row.expense.toFloat()),
                    color: 2,
                  },
                ]}
                line={{
                  name: B.net,
                  values: state.flowRows.map((row) => row.net.toFloat()),
                  color: 3,
                }}
                valueKind="amount"
                height={280}
                accessibleSummary={state.flowSummary}
                tooltip={state.flowTip}
              />
            )}
          </Card>
        </>
      )}
      {state.tab === "subs" && (
        <Card label={B.subscriptions} padding="lg">
          {state.subscriptions.length === 0 ? (
            <p>{B.empty}</p>
          ) : (
            <WindowRows
              rows={state.subscriptions}
              rowKey={(row) => `${row.counterparty}:${row.currency}:${row.typicalAmount}`}
            >
              {(row) => (
                <div className="grid gap-3 sm:grid-cols-4">
                  <span>
                    {state.privacy ? "•••" : row.counterparty}
                    <span className="block text-caption text-fg-muted">
                      {row.active ? B.active : B.stale}
                    </span>
                  </span>
                  <Money value={new MoneyValue(row.typicalAmount, row.currency)} />
                  <span>{B.everyDays(row.medianGapDays)}</span>
                  <DateText value={row.lastDate} />
                </div>
              )}
            </WindowRows>
          )}
        </Card>
      )}
      {state.categoriesOpen && (
        <Modal
          label={B.uncategorized}
          onClose={state.closeCategories}
          placement="center"
          closeOnBackdrop={false}
        >
          {state.message && <p role="status">{state.message}</p>}
          <div className="mb-4 flex justify-between">
            <h2 className="text-title">{B.uncategorized}</h2>
            <Button onPress={state.closeCategories}>{B.close}</Button>
          </div>
          {state.categoryRows.length === 0 ? (
            <p>{B.allDone}</p>
          ) : (
            state.categoryRows.map((row) => (
              <div
                key={row.merchantKey}
                className="grid items-center gap-3 border-b border-border py-3 sm:grid-cols-4"
              >
                <span>{state.privacy ? "•••" : row.sample}</span>
                <span>{row.count}</span>
                <Money value={new MoneyValue(row.total, row.currency)} />
                <CategoryChoice
                  state={state}
                  value={state.saved[row.merchantKey] ?? ""}
                  onChange={(category) => void state.markMerchant(row.merchantKey, category)}
                />
              </div>
            ))
          )}
        </Modal>
      )}
      {state.cushionOpen && <CushionForm state={state} />}
      {state.importOpen && (
        <Modal
          label={B.import}
          onClose={() => state.setImportOpen(false)}
          placement="center"
          closeOnBackdrop={false}
        >
          <h2 className="text-title">{B.import}</h2>
          <ol className="my-4 flex flex-wrap gap-4">
            {[B.source, B.file, B.preview, B.done].map((step, index) => (
              <li
                key={step}
                aria-current={index === 0 ? "step" : undefined}
                className={index === 0 ? "font-strong" : "text-fg-muted"}
              >
                {index + 1}. {step}
              </li>
            ))}
          </ol>
          <p>{B.importUnavailable}</p>
          <div className="mt-4 flex gap-3">
            <Button onPress={() => state.setImportOpen(false)}>{B.close}</Button>
          </div>
        </Modal>
      )}
    </main>
  );
}
