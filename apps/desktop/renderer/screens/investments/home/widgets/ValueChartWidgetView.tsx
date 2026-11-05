// ValueChartWidget (ab24ab6 v2/Perf.tsx:26-107): `Widget#inv-value` with the quiet range Seg, the legend
// (the portfolio mark stacked above its word, old `.split .main` cascade), the line chart / table / empty line and
// the footer facts with the chart | table toggle.
import {
  Button,
  ChartLegend,
  codeCls,
  emptyCls,
  LineChart,
  Seg,
  tableCls,
  tdCls,
  thCls,
  Widget,
} from "@cashu/ui";
import type { ValueChartWidgetProps } from "./valueChartModel.js";

export function ValueChartWidgetView({
  title,
  rangeLabel,
  ranges,
  range,
  onRange,
  legend,
  body,
  footer,
}: ValueChartWidgetProps) {
  return (
    <Widget
      title={title}
      id="inv-value"
      tight
      controls={<Seg quiet label={rangeLabel} value={range} onChange={onRange} items={ranges} />}
      footer={
        footer && (
          <>
            {footer.facts.map((f) => (
              <span key={f.lead} title={f.title}>
                {f.lead}
                {f.value != null && <b>{f.value}</b>}
              </span>
            ))}
            <span className="flex-1" />
            <Button
              variant="link"
              size="md"
              pressed={footer.toggle.pressed}
              onPress={footer.toggle.onToggle}
            >
              {footer.toggle.text}
            </Button>
          </>
        )
      }
    >
      <ChartLegend className="mb-1.5" items={legend} />
      {body.kind === "empty" ? (
        <div className={emptyCls}>
          {body.text}
          {body.code != null && (
            <>
              <code className={codeCls}>{body.code}</code>.
            </>
          )}
        </div>
      ) : body.kind === "table" ? (
        <div className="mt-2 max-h-65 overflow-auto">
          <table className={tableCls(false)}>
            <thead>
              <tr>
                {body.columns.map((col) => (
                  <th key={col.label} className={thCls(col.num)}>
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.rows.map((row) => (
                <tr key={row.key}>
                  {row.cells.map((text, k) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: fixed column positions.
                      key={k}
                      className={tdCls(body.columns[k]?.num ?? false)}
                    >
                      {text}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <LineChart {...body.chart} />
      )}
    </Widget>
  );
}
