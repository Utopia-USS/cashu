// "Kategorie" drawer (ab24ab6 modules/budget/CategoriesDrawer.tsx + budget.css `.catd`): merchants without a
// category in a fixed-column table, one category select per merchant, the rule hint in the foot.
import { S } from "@cashu/i18n/budget/CategoriesDrawer.strings";
import { C } from "@cashu/i18n/core/common.strings";
import { Button, Drawer, Notice, Select, Skeleton, Tag } from "@cashu/ui";
import type { ReactNode } from "react";
import type { CategoriesDrawerState } from "./useCategoriesDrawer.js";

// The drawer table (index.css `.drawer table/th/td`): 13px, 6px 4px cells, nowrap but the last column.
const th = (num = false) =>
  `whitespace-nowrap border-b border-border px-1 py-1.5 text-xs font-strong uppercase tracking-column text-fg-muted ${num ? "text-right" : "text-left"}`;
const td = (num = false) =>
  `border-b border-border px-1 py-1.5 ${num ? "whitespace-nowrap text-right tabular-nums" : ""}`;

function Frame({
  count,
  onClose,
  children,
}: {
  count: number | null;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <Drawer
      title={S.title}
      label={S.label}
      width={560}
      onClose={onClose}
      tag={count !== null ? <Tag>{S.uncategorized(count)}</Tag> : undefined}
      footer={
        <>
          <span className="text-xs text-fg-muted">{S.ruleHint}</span>
          <span className="flex-1" />
          <Button onPress={onClose}>{C.close}</Button>
        </>
      }
    >
      {children}
    </Drawer>
  );
}

export function CategoriesDrawerView({ state }: { state: CategoriesDrawerState }) {
  return (
    <Frame count={state.rows.length} onClose={state.close}>
      {state.error && <Notice tone="negative">{state.error}</Notice>}
      {!state.rows.length ? (
        <div className="px-5 py-7 text-center text-md text-fg-muted">{S.allDone}</div>
      ) : (
        <table className="w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col />
            <col className="w-12" />
            <col className="w-21" />
            <col className="w-41" />
          </colgroup>
          <thead>
            <tr>
              <th className={th()}>{S.colMerchant}</th>
              <th className={th(true)}>{S.colCount}</th>
              <th className={th(true)}>{S.colSum}</th>
              <th className={th()}>{S.colCategory}</th>
            </tr>
          </thead>
          <tbody>
            {state.rows.map((r) => (
              <tr key={r.key}>
                <td className={`${td()} [overflow-wrap:anywhere]`} title={r.title}>
                  <b className="line-clamp-2">{r.sample}</b>
                  {r.sub && <div className="truncate text-xs text-fg-muted">{r.sub}</div>}
                </td>
                <td className={td(true)}>{r.count}</td>
                <td className={td(true)}>{r.total}</td>
                <td className={td()}>
                  <Select
                    label={S.categoryOf(r.sample)}
                    labelHidden
                    className="w-full"
                    value={r.picked}
                    options={state.options}
                    onChange={r.choose}
                  />
                  {r.saved && (
                    <div>
                      <Tag tone="positive">{S.saved}</Tag>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Frame>
  );
}

/** While the list loads (old four 28px skeleton rows). */
export function CategoriesDrawerLoadingView({ onClose }: { onClose(): void }) {
  return (
    <Frame count={null} onClose={onClose}>
      <div className="grid gap-2.5">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={28} />
        ))}
      </div>
    </Frame>
  );
}
