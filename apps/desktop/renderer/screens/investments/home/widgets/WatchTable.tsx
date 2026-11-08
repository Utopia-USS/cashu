// The Obserwowane tab of Aktywa (ab24ab6 v2/Watchlist.tsx WatchTable `wide`, laid out as design V5): Instrument
// (ticker over name) | 30 dni | Cena over the week | Rekomendacja (+ the coverage `n/m`) | Alerty | X; rows open the
// asset. The strategy hints and a stale price live in the tile's hover card. Texts come from assetListModel.ts.
import { Button, emptyCls, Skeleton, Sparkline, toneCls } from "@cashu/ui";
import {
  cInst,
  cSpark,
  rowCls,
  stackCls,
  stackTop,
  tableCls,
  tdCls,
  thCls,
} from "./assetColumns.js";
import type { AssetListProps } from "./assetListModel.js";
import { RowLabelCell } from "./assetParts.js";

export function WatchTable({ watch }: { watch: AssetListProps["watch"] }) {
  const { rows, head } = watch;
  if (!rows)
    return (
      <div className="px-5 py-2">
        <Skeleton height={80} />
      </div>
    );
  if (!rows.length) return <div className={emptyCls}>{watch.empty}</div>;
  return (
    <div className="overflow-x-auto">
      <table className={tableCls}>
        <thead>
          <tr>
            <th className={`${thCls()} ${cInst}`}>{head.inst}</th>
            <th className={`${thCls()} ${cSpark}`}>
              <span className="sr-only">{head.spark}</span>
            </th>
            <th className={thCls(true)}>{`${head.price} · ${head.week}`}</th>
            <th className={thCls()}>
              {head.recommendation}{" "}
              <span className="ml-0.75 whitespace-nowrap text-3xs-plus text-fg-muted">
                {head.coverage}
              </span>
            </th>
            <th className={thCls()}>{head.alerts}</th>
            <th className={`${thCls()} w-7`}>
              <span className="sr-only">{head.actions}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => (
            <tr
              key={w.key}
              className={rowCls}
              onClick={(e) => {
                if (!(e.target as HTMLElement).closest("button, a, input, select")) w.onOpen();
              }}
            >
              <td className={`${tdCls()} ${cInst}`}>
                {w.label ? (
                  <RowLabelCell label={w.label} onOpen={w.onOpen} />
                ) : (
                  <button
                    type="button"
                    onClick={w.onOpen}
                    className="cursor-pointer border-0 bg-transparent p-0 text-left font-strong text-fg hover:text-accent"
                  >
                    {w.name}
                  </button>
                )}
              </td>
              <td className={`${tdCls()} ${cSpark}`}>
                <Sparkline {...w.spark} />
              </td>
              <td className={tdCls(true)}>
                <span className={stackCls}>
                  {w.price != null ? (
                    <b className={stackTop}>{w.price}</b>
                  ) : (
                    <span className="text-fg-muted">{w.noPrice}</span>
                  )}
                  <span className={`text-xs-plus ${toneCls[w.move.tone]}`} title={w.move.title}>
                    {w.move.text}
                  </span>
                </span>
              </td>
              <td className={`${tdCls()} whitespace-nowrap`}>
                {w.recommendation ? (
                  <span className="text-fg" title={w.recommendation.title}>
                    {w.recommendation.text}
                  </span>
                ) : (
                  <span className="text-fg-muted">{w.noRecommendation}</span>
                )}
              </td>
              <td
                className={`${tdCls()} whitespace-nowrap text-xs-plus ${w.alerts.muted ? "text-fg-muted" : ""}`}
              >
                {w.alerts.text}
              </td>
              <td className={`${tdCls()} w-7 pl-0`}>
                <Button
                  variant="icon"
                  title={w.remove.title}
                  label={w.remove.label}
                  disabled={w.remove.disabled}
                  onPress={w.remove.onPress}
                >
                  ✕
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
