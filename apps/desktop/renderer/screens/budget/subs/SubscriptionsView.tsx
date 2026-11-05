// The Subskrypcje tab body (ab24ab6 modules/budget/Subscriptions.tsx): the titled card with the payments
// table (payee + `aktywna` tag, amount, gap in days, last payment). Pure.
import { S } from "@cashu/i18n/budget/Subscriptions.strings";
import { dataTableCls, dataTdCls, dataThCls, SectionCard, scrollCls, Tag } from "@cashu/ui";
import type { SubscriptionsScreenState } from "./useSubscriptionsScreen.js";

const num = `${dataTdCls(true)} whitespace-nowrap`;

export function SubscriptionsView({ state }: { state: SubscriptionsScreenState }) {
  return (
    <SectionCard id="budget-subs" title={S.title}>
      <div className={scrollCls()}>
        <table className={dataTableCls}>
          <thead>
            <tr>
              <th className={dataThCls()}>{S.payee}</th>
              <th className={`${dataThCls(true)} whitespace-nowrap`}>{S.amount}</th>
              <th className={`${dataThCls(true)} whitespace-nowrap`}>{S.every}</th>
              <th className={dataThCls()}>{S.last}</th>
            </tr>
          </thead>
          <tbody>
            {!state.rows.length ? (
              <tr>
                <td colSpan={4} className={`${dataTdCls()} text-fg-muted`}>
                  {S.none}
                </td>
              </tr>
            ) : (
              state.rows.map((r) => (
                <tr key={r.key}>
                  <td className={dataTdCls()}>
                    {r.payee} {r.active && <Tag tone="positive">{S.active}</Tag>}
                  </td>
                  <td className={num}>{r.amount}</td>
                  <td className={num}>{r.every}</td>
                  <td className={`${dataTdCls()} text-fg-muted`}>{r.last}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
