// ContributionsWidget (ab24ab6 v2/Perf.tsx:132-160): `Widget#inv-contrib` with the `12 mies.` tag in the controls,
// the two facts (W tym roku, Następna) and the 12-month bars with the plan line, else `.empty`; a 150px skeleton
// before the read answers. Pure: the props come from contributionsModel.ts.
import { BarChart, emptyCls, Facts, Skeleton, Tag, Widget } from "@cashu/ui";
import type { ContributionsWidgetProps } from "./contributionsModel.js";

export function ContributionsWidgetView({ title, count, body }: ContributionsWidgetProps) {
  return (
    <Widget title={title} id="inv-contrib" controls={<Tag>{count}</Tag>} tight>
      {body === null ? (
        <Skeleton height={150} />
      ) : (
        <>
          <Facts items={body.facts} className="mb-1.5" />
          {body.chart ? <BarChart {...body.chart} /> : <div className={emptyCls}>{body.empty}</div>}
        </>
      )}
    </Widget>
  );
}
