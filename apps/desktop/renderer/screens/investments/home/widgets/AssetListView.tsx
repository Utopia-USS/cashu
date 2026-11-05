// AssetList (ab24ab6 v2/Portfolio.tsx:41-176): `Widget#inv-assets` (a size container) with the `Portfel n |
// Obserwowane n` tabs, the split Seg and the sort select (or `+ Dodaj` on the watch tab), the positions table or
// the watch table, and the footer (`+ transakcja` / the live alerts count).
import {
  Button,
  HintChip,
  rowLinkCls,
  Seg,
  Select,
  Sparkline,
  sumRowCls,
  Tag,
  tableCls,
  tdCls,
  thCls,
  toneCls,
  WeightBar,
  Widget,
} from "@cashu/ui";
import { cHint, cHintTd, cInst, cNarrowHidden, splitNowrap } from "./assetColumns.js";
import type { AssetListProps, AssetSort } from "./assetListModel.js";
import { GainCell, RowLabelCell } from "./assetParts.js";
import { WatchTable } from "./WatchTable.js";

export function AssetListView({ title, tabs, tab, positions, watch }: AssetListProps) {
  const p = positions;
  return (
    <Widget
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
          <>
            <Seg
              quiet
              label={p.split.label}
              value={p.split.value}
              onChange={p.split.onChange}
              items={p.split.items}
            />
            <Select
              labelHidden
              label={p.sort.label}
              value={p.sort.value}
              onChange={(v) => p.sort.onChange(v as AssetSort)}
              options={p.sort.options}
            />
          </>
        ) : (
          <Button size="sm" expanded={watch.add.expanded} onPress={watch.add.onPress}>
            {watch.add.text}
          </Button>
        )
      }
      footer={
        tab === "positions" ? (
          <>
            <span className="flex-1" />
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
          </>
        )
      }
    >
      {tab === "watch" ? (
        <WatchTable watch={watch} />
      ) : (
        <div className="overflow-x-auto">
          <table className={`${tableCls(true)} -mt-0.5 ${splitNowrap}`}>
            <thead>
              <tr>
                <th className={`${thCls()} ${cInst}`}>{p.head.inst}</th>
                <th className={`${thCls()} ${cHint}`}>{p.head.strategy}</th>
                <th className={`${thCls()} ${cNarrowHidden}`}>{p.head.spark}</th>
                <th className={thCls(true)}>{p.head.price}</th>
                <th className={thCls(true)}>{p.head.week}</th>
                <th className={thCls()}>{p.head.weight}</th>
                <th className={thCls(true)}>{p.head.value}</th>
                <th className={`${thCls(true)} ${cNarrowHidden}`} title={p.head.resultTitle}>
                  {p.head.result}
                </th>
                <th className={thCls(true)}>{p.head.resultPct}</th>
              </tr>
            </thead>
            <tbody>
              {p.rows.flatMap((r) => [
                <tr
                  key={r.key}
                  className={rowLinkCls}
                  onClick={(e) => {
                    if (!(e.target as HTMLElement).closest("button, a, input, select")) r.onOpen();
                  }}
                >
                  <td className={`${tdCls()} ${cInst}`}>
                    <RowLabelCell label={r.label} onOpen={r.onOpen} />
                  </td>
                  <td className={`${tdCls()} ${cHint} ${cHintTd}`}>
                    {r.hint && <HintChip {...r.hint} />}
                  </td>
                  <td className={`${tdCls()} ${cNarrowHidden}`}>
                    <Sparkline {...r.spark} />
                  </td>
                  <td className={tdCls(true)}>
                    {r.price}
                    {r.priceStale != null && (
                      <>
                        {" "}
                        <Tag tone="warning">{r.priceStale}</Tag>
                      </>
                    )}
                  </td>
                  <td className={`${tdCls(true)} ${toneCls[r.week.tone]}`}>{r.week.text}</td>
                  <td className={`${tdCls()} whitespace-nowrap`}>
                    <WeightBar {...r.weight} />
                  </td>
                  <td className={tdCls(true)}>{r.value}</td>
                  <td
                    className={`${tdCls(true)} ${cNarrowHidden} ${r.result.tone ? toneCls[r.result.tone] : ""}`}
                  >
                    {r.result.text}
                  </td>
                  <GainCell {...r.gain} />
                </tr>,
                ...r.parts.map((a) => (
                  <tr key={a.key} className={sumRowCls}>
                    <td className={`${tdCls()} pl-7!`}>{a.account}</td>
                    <td className={`${tdCls()} ${cHint} ${cHintTd}`} />
                    <td className={`${tdCls()} ${cNarrowHidden}`} />
                    <td className={tdCls()} />
                    <td className={tdCls()} />
                    <td className={`${tdCls()} whitespace-nowrap`}>
                      <WeightBar {...a.weight} />
                    </td>
                    <td className={tdCls(true)}>{a.value}</td>
                    <td className={`${tdCls(true)} ${cNarrowHidden}`} />
                    <GainCell {...a.gain} />
                  </tr>
                )),
              ])}
              {p.empty != null && (
                <tr>
                  <td colSpan={9} className={`${tdCls()} text-fg-muted`}>
                    {p.empty}
                  </td>
                </tr>
              )}
              {p.cash && (
                <tr className={sumRowCls}>
                  <td className={tdCls()}>{p.cash.label}</td>
                  <td className={`${tdCls()} ${cHint} ${cHintTd}`} />
                  <td className={`${tdCls()} ${cNarrowHidden}`} />
                  <td className={tdCls()} />
                  <td className={tdCls()} />
                  <td className={`${tdCls()} whitespace-nowrap`}>
                    <WeightBar {...p.cash.weight} />
                  </td>
                  <td className={tdCls(true)}>{p.cash.value}</td>
                  <td className={`${tdCls()} ${cNarrowHidden}`} />
                  <td className={tdCls()} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Widget>
  );
}
