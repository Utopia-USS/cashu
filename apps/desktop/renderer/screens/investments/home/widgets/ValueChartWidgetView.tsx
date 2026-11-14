// ValueChartWidget (ab24ab6 v2/Perf.tsx:26-107, laid out as design V5): the quiet card `#inv-value` with the
// benchmark in words next to the title, the chart | table toggle and the range Seg, the legend line (series marks,
// the benchmark's return, the difference, the benchmark status), the line chart / table / empty line, then the KPI
// strip inside the card (hairline dividers). Pure: the props come from valueChartModel.ts.
import {
  Button,
  codeCls,
  emptyCls,
  LineChart,
  Seg,
  tableCls,
  tdCls,
  thCls,
  toneCls,
  Widget,
} from "@cashu/ui";
import type { KpiCell, KpiLine, ValueChartWidgetProps } from "./valueChartModel.js";

const mark = {
  main: "inline-block h-0 w-3.5 border-t-2 border-accent",
  bench: "inline-block h-0 w-3.5 border-t-2 border-dashed border-bench",
} as const;

function Legend({ legend, status }: Pick<ValueChartWidgetProps, "legend" | "status">) {
  return (
    <div className="mb-2.5 flex min-h-5.5 flex-wrap items-center gap-x-4.5 gap-y-1 text-xs text-fg-muted">
      {legend.map((e) => (
        <span key={e.key} className="inline-flex items-center gap-1.75">
          {e.mark && <i aria-hidden="true" className={mark[e.mark]} />}
          {e.label}
          {e.value != null && (
            <b className={`font-medium tabular-nums ${e.tone ? toneCls[e.tone] : "text-fg"}`}>
              {e.value}
            </b>
          )}
        </span>
      ))}
      {status && (
        <>
          <span className="flex-1" />
          <span
            title={status.title}
            className={`inline-flex items-center gap-1.75 ${status.warn ? "text-fg-secondary" : ""}`}
          >
            <i
              aria-hidden="true"
              className={`size-1.5 rounded-full ${status.warn ? "bg-warning" : "bg-fg-muted"}`}
            />
            {status.text}
          </span>
        </>
      )}
    </div>
  );
}

function Line({ line }: { line: KpiLine }) {
  return (
    <span title={line.title} className="whitespace-nowrap text-xs text-fg-muted">
      {line.parts.map((p, k) =>
        p.tone ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one line are a fixed, ordered list.
          <span key={k} className={toneCls[p.tone]}>
            {p.text}
          </span>
        ) : (
          p.text
        ),
      )}
    </span>
  );
}

function Kpi({ cell }: { cell: KpiCell }) {
  return (
    <div
      title={cell.title}
      className="grid min-w-0 content-start gap-1 border-l border-border px-5 pt-4 pb-4.5 first:border-l-0 max-narrow:nth-3:border-l-0"
    >
      <span className="text-xs text-fg-muted">{cell.label}</span>
      <span
        className={`whitespace-nowrap text-xl font-heavy leading-snug tracking-heading tabular-nums ${cell.tone ? toneCls[cell.tone] : "text-fg"}`}
      >
        {cell.value}
      </span>
      {cell.bar != null && (
        <span
          aria-hidden="true"
          className="my-0.75 block h-0.75 max-w-40 overflow-hidden rounded-full bg-chip"
        >
          <i
            className="block h-full rounded-full bg-fg-secondary"
            style={{ width: `${Math.round(cell.bar * 100)}%` }}
          />
        </span>
      )}
      {cell.lines.map((line) => (
        <Line key={line.key} line={line} />
      ))}
    </div>
  );
}

export function ValueChartWidgetView({
  title,
  sub,
  rangeLabel,
  ranges,
  range,
  onRange,
  toggle,
  legend,
  status,
  body,
  kpis,
}: ValueChartWidgetProps) {
  return (
    <Widget
      variant="quiet"
      title={title}
      id="inv-value"
      tags={sub != null && <span className="text-xs text-fg-muted">{sub}</span>}
      controls={
        <>
          {toggle && (
            <Button variant="link" size="md" pressed={toggle.pressed} onPress={toggle.onToggle}>
              {toggle.text}
            </Button>
          )}
          <Seg quiet label={rangeLabel} value={range} onChange={onRange} items={ranges} />
        </>
      }
    >
      <Legend legend={legend} status={status} />
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
      {kpis.length > 0 && (
        <div className="-mx-5 mt-4.5 -mb-5 grid grid-cols-4 border-t border-border max-narrow:grid-cols-2">
          {kpis.map((cell) => (
            <Kpi key={cell.key} cell={cell} />
          ))}
        </div>
      )}
    </Widget>
  );
}
