// The Obserwowane tab of Aktywa (ab24ab6 v2/Watchlist.tsx WatchTable `wide`): Instrument | Rekomendacja (+ the
// coverage `n/m`) | 30 dni | Cena | tydz. | Alerty | X; rows open the asset. Texts come from assetListModel.ts.
import { Button, Skeleton, Sparkline, Tag } from "@cashu/ui";
import { cHint, cHintTd, cInst, cNarrowHidden, splitNowrap } from "./assetColumns.js";
import type { AssetListProps } from "./assetListModel.js";
import { RowLabelCell } from "./assetParts.js";
import { HintChip } from "./marks.js";
import { emptyCls, rowLinkCls, tableCls, tdCls, thCls, toneCls } from "./table.js";

const plan =
  "inline-flex max-w-39.5 whitespace-nowrap rounded-full border px-1.75 py-px text-2xs-plus leading-normal";

export function WatchTable({ watch }: { watch: AssetListProps["watch"] }) {
  const { rows, head } = watch;
  if (!rows)
    return (
      <div className="px-4 py-2">
        <Skeleton height={80} />
      </div>
    );
  if (!rows.length) return <div className={emptyCls}>{watch.empty}</div>;
  return (
    <div className="overflow-x-auto">
      <table className={`${tableCls(true)} -mt-0.5 ${splitNowrap}`}>
        <thead>
          <tr>
            <th className={`${thCls()} ${cInst}`}>{head.inst}</th>
            <th className={`${thCls()} ${cHint}`}>
              {head.recommendation}{" "}
              <span className="ml-0.75 whitespace-nowrap text-3xs-plus font-medium text-fg-muted">
                {head.coverage}
              </span>
            </th>
            <th className={`${thCls()} ${cNarrowHidden}`}>{head.spark}</th>
            <th className={thCls(true)}>{head.price}</th>
            <th className={thCls(true)}>{head.week}</th>
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
              className={rowLinkCls}
              onClick={(e) => {
                if (!(e.target as HTMLElement).closest("button, a, input, select")) w.onOpen();
              }}
            >
              <td className={`${tdCls()} ${cInst}`}>
                {w.label ? (
                  <RowLabelCell label={w.label} onOpen={w.onOpen} />
                ) : (
                  <span className="font-strong">
                    <button
                      type="button"
                      onClick={w.onOpen}
                      className="cursor-pointer border-0 bg-transparent p-0 text-left font-strong text-fg hover:text-accent"
                    >
                      {w.name}
                    </button>
                  </span>
                )}
              </td>
              <td className={`${tdCls()} ${cHint} ${cHintTd}`}>
                <div className="flex min-w-0 flex-col items-start gap-0.75">
                  {w.recommendation ? (
                    <span
                      className={`${plan} border-fg-muted font-strong text-fg`}
                      title={w.recommendation.title}
                    >
                      {w.recommendation.text}
                    </span>
                  ) : (
                    <span
                      className={`${plan} border-dashed border-fg-muted font-medium text-fg-muted`}
                    >
                      {w.noRecommendation}
                    </span>
                  )}
                  {w.hint && <HintChip {...w.hint} />}
                </div>
              </td>
              <td className={`${tdCls()} ${cNarrowHidden}`}>
                <Sparkline {...w.spark} />
              </td>
              <td className={tdCls(true)}>
                {w.price ?? <span className="text-fg-muted">{w.noPrice}</span>}
                {w.stale != null && (
                  <>
                    {" "}
                    <Tag tone="warning">{w.stale}</Tag>
                  </>
                )}
              </td>
              <td className={`${tdCls(true)} ${toneCls[w.move.tone]}`} title={w.move.title}>
                {w.move.text}
              </td>
              <td className={`${tdCls()} ${w.alerts.muted ? "text-fg-muted" : ""}`}>
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
