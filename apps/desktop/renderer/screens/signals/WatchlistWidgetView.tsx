// The ported standalone Obserwowane widget (ab24ab6 v2/Watchlist.tsx WatchlistWidget + WatchTable narrow: the light
// grid of a zero-start profile; the full Home shows the list as the Aktywa tab): `+ Dodaj` opens the search row,
// each row = the compact identity label with its summary | 30-day spark | price (+ week) | X. Pure.
import { S } from "@cashu/i18n/investments/v2/Watchlist.strings";
import {
  AgentTag,
  Button,
  emptyCls,
  InstLabel,
  Skeleton,
  Sparkline,
  Tag,
  tableCls,
  tdCls,
  Widget,
} from "@cashu/ui";
import type { ReactNode } from "react";
import type { WatchNarrowRow } from "./watchModel.js";

export interface WatchlistWidgetProps {
  count: number | null;
  adding: boolean;
  onAdd(): void;
  /** The search row while adding. */
  search: ReactNode;
  /** Null while the list loads. */
  rows: WatchNarrowRow[] | null;
  alerts: number;
  alertsWord: string;
}

const iconBtn =
  "cursor-pointer border-0 bg-transparent px-1.5 py-0.5 font-control text-base leading-control text-fg-muted hover:text-negative disabled:cursor-default disabled:opacity-60";
const nameBtn =
  "cursor-pointer border-0 bg-transparent p-0 text-left font-strong text-fg hover:text-accent";

export function WatchlistWidgetView(p: WatchlistWidgetProps) {
  return (
    <Widget
      title={S.title}
      count={p.count ?? undefined}
      id="inv-watch"
      tight
      flush
      controls={
        <Button size="sm" onPress={p.onAdd} expanded={p.adding}>
          {S.add}
        </Button>
      }
      footer={
        // The old FootFacts band is there even without a fact (an empty string keeps it).
        p.alerts > 0 ? (
          <span>
            <b>{p.alerts}</b> {p.alertsWord}
          </span>
        ) : (
          ""
        )
      }
    >
      {p.search}
      {!p.rows ? (
        <div className="px-4 py-2">
          <Skeleton height={80} />
        </div>
      ) : !p.rows.length ? (
        <div className={emptyCls}>{S.empty}</div>
      ) : (
        <table className={tableCls(true)}>
          <tbody>
            {p.rows.map((w) => (
              <tr key={w.key}>
                <td className={`${tdCls()} w-full`}>
                  {w.tile ? (
                    <InstLabel
                      {...w.tile}
                      density="compact"
                      name={w.name}
                      onOpen={w.onOpen}
                      badges={w.agent ? <AgentTag text="agent" /> : undefined}
                      sub={w.summary}
                    />
                  ) : (
                    <>
                      <button type="button" onClick={w.onOpen} className={nameBtn}>
                        {w.name}
                      </button>
                      {w.agent && (
                        <>
                          {" "}
                          <AgentTag text="agent" />
                        </>
                      )}
                      <span className="-mt-px block text-2xs-plus text-fg-muted">{w.summary}</span>
                    </>
                  )}
                </td>
                <td className={`${tdCls()} w-18`}>
                  <Sparkline {...w.spark} />
                </td>
                <td className={tdCls(true)}>
                  {w.price ?? <span className="text-fg-muted">{w.noPrice}</span>}
                  {w.stale && (
                    <Tag tone="warning" className="ml-1">
                      {w.stale}
                    </Tag>
                  )}
                  <span
                    className={`-mt-px block text-2xs-plus ${w.move.tone === "positive" ? "text-positive" : w.move.tone === "negative" ? "text-negative" : "text-fg-muted"}`}
                  >
                    {w.move.text}
                  </span>
                </td>
                <td className={`${tdCls()} w-7 pl-0`}>
                  <button
                    type="button"
                    title={w.remove.title}
                    aria-label={w.remove.label}
                    disabled={w.remove.disabled}
                    onClick={w.remove.onPress}
                    className={iconBtn}
                  >
                    {"✕"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Widget>
  );
}
