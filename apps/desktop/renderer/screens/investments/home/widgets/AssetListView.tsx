// AssetList (ab24ab6 v2/Portfolio.tsx:41-176, laid out as design V5): the quiet card `#inv-assets` (a size
// container) with the `Portfel n | Obserwowane n` tabs, the split Seg (or `+ Dodaj` on the watch tab), the positions
// table with two-line cells and sortable heads (or the watch table), and the footer: the cash line, the legend of
// the tile marks (thesis rings, recommendation coin) and `+ transakcja` (the watch tab: the live alerts count).

import { Button, InstTile, PlanGlyph, Seg, Sparkline, toneCls, WeightBar, Widget } from "@cashu/ui";
import type { ReactNode } from "react";
import {
  cInst,
  cSpark,
  rowCls,
  stackCls,
  stackTop,
  subTdCls,
  tableCls,
  tdCls,
  thCls,
} from "./assetColumns.js";
import type { AssetListProps, AssetSort } from "./assetListModel.js";
import { GainCell, RowLabelCell } from "./assetParts.js";
import { WatchTable } from "./WatchTable.js";

type Positions = AssetListProps["positions"];

/** A sortable column head (descending only, like the old sort select): the active one shows its chevron. */
function SortHead({
  head,
  sort,
  onSort,
}: {
  head: Positions["head"]["price"];
  sort: AssetSort;
  onSort(sort: AssetSort): void;
}) {
  const on = head.sort === sort;
  return (
    <th className={thCls(true)} aria-sort={on ? "descending" : undefined}>
      <button
        type="button"
        title={head.title}
        aria-pressed={on}
        onClick={() => onSort(head.sort)}
        className={`inline-flex cursor-pointer items-center gap-0.75 border-0 bg-transparent p-0 hover:text-fg-secondary ${on ? "text-fg-secondary" : "text-fg-muted"}`}
      >
        {head.text}
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          className={`size-2.75 fill-none stroke-current ${on ? "" : "opacity-0"}`}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4.5 6.5 8 10l3.5-3.5" />
        </svg>
      </button>
    </th>
  );
}

/** The footer's legend of the tile marks (design V5): the four thesis rings and the recommendation coin. */
function TileLegend({ legend }: { legend: Positions["legend"] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {legend.thesis}
      {legend.rings.map((r) => (
        <span key={r.health} className="inline-flex items-center gap-1.5">
          <InstTile monogram="" density="mark" health={r.health} />
          {r.text}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <PlanGlyph path={legend.coin.path} className="size-3.5" />
        {legend.coin.text}
      </span>
    </span>
  );
}

/** `search` = the `+ Dodaj` instrument search row (old WatchTable `addRow`), above the watch list while adding. */
export function AssetListView({
  title,
  tabs,
  tab,
  positions,
  watch,
  search,
}: AssetListProps & { search?: ReactNode }) {
  const p = positions;
  return (
    <Widget
      variant="quiet"
      title={title}
      id="inv-assets"
      className="@container"
      tight
      flush
      tags={
        <Seg
          quiet
          label={tabs.label}
          value={tabs.value}
          onChange={tabs.onChange}
          items={tabs.items}
        />
      }
      controls={
        tab === "positions" ? (
          <Seg
            quiet
            label={p.split.label}
            value={p.split.value}
            onChange={p.split.onChange}
            items={p.split.items}
          />
        ) : (
          <Button size="sm" expanded={watch.add.expanded} onPress={watch.add.onPress}>
            {watch.add.text}
          </Button>
        )
      }
      footer={
        tab === "positions" ? (
          <>
            {p.cash && (
              <span>
                {p.cash.label} <b>{p.cash.value}</b> · {p.cash.share}
              </span>
            )}
            <span className="flex-1" />
            <TileLegend legend={p.legend} />
            <Button variant="link" size="md" onPress={p.addTxn.onPress}>
              {p.addTxn.text}
            </Button>
          </>
        ) : (
          <>
            <span>
              <b>{watch.alertsCount}</b> {watch.alertsWord}
            </span>
            <span className="flex-1" />
            <TileLegend legend={p.legend} />
          </>
        )
      }
    >
      {tab === "watch" ? (
        <>
          {search}
          <WatchTable watch={watch} />
        </>
      ) : (
        <div className="overflow-x-auto">
          <table className={tableCls}>
            <thead>
              <tr>
                <th className={`${thCls()} ${cInst}`}>{p.head.inst}</th>
                <th className={`${thCls()} ${cSpark}`}>
                  <span className="sr-only">{p.head.spark}</span>
                </th>
                <SortHead head={p.head.price} sort={p.sort.value} onSort={p.sort.onChange} />
                <SortHead head={p.head.weight} sort={p.sort.value} onSort={p.sort.onChange} />
                <SortHead head={p.head.value} sort={p.sort.value} onSort={p.sort.onChange} />
              </tr>
            </thead>
            <tbody>
              {p.rows.flatMap((r) => [
                <tr
                  key={r.key}
                  className={rowCls}
                  onClick={(e) => {
                    if (!(e.target as HTMLElement).closest("button, a, input, select")) r.onOpen();
                  }}
                >
                  <td className={`${tdCls()} ${cInst}`}>
                    <RowLabelCell label={r.label} onOpen={r.onOpen} />
                  </td>
                  <td className={`${tdCls()} ${cSpark}`}>
                    <Sparkline {...r.spark} />
                  </td>
                  <td className={tdCls(true)}>
                    <span className={stackCls}>
                      <b className={stackTop}>{r.price}</b>
                      <span className={`text-xs-plus ${toneCls[r.week.tone]}`}>{r.week.text}</span>
                    </span>
                  </td>
                  <td className={tdCls(true)}>
                    <WeightBar {...r.weight} stacked />
                  </td>
                  <GainCell {...r.gain} value={r.value} className={tdCls(true)} />
                </tr>,
                ...r.parts.map((a) => (
                  <tr key={a.key}>
                    <td className={`${subTdCls()} pl-17.5!`}>{a.account}</td>
                    <td className={`${subTdCls()} ${cSpark}`} />
                    <td className={subTdCls()} />
                    <td className={subTdCls(true)}>
                      <WeightBar {...a.weight} stacked />
                    </td>
                    <GainCell {...a.gain} value={a.value} className={subTdCls(true)} />
                  </tr>
                )),
              ])}
              {p.empty != null && (
                <tr>
                  <td colSpan={5} className={`${subTdCls()} text-center`}>
                    {p.empty}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Widget>
  );
}
