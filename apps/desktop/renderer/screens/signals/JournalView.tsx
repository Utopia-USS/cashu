// The ported decision journal page (ab24ab6 v2/Journal.tsx; index.css `.tl.wide`, `.facts`, `.w table`): the
// filters, the record grouped by month with its `pokaż więcej`, the year in numbers and the signals history. Pure.
import {
  Button,
  Crumb,
  emptyCls,
  type FactProps,
  Facts,
  Grid,
  PageHead,
  PolarityText,
  PolDot,
  Seg,
  Skeleton,
  tableCls,
  tdCls,
  thCls,
  Widget,
} from "@cashu/ui";
import { Fragment } from "react";
import { selectCls } from "./fields.js";
import type { HistoryLine, Part, RecordRow } from "./journalModel.js";
import type { Press } from "./signalsDialogModel.js";

type JournalFilter = "all" | "decisions" | "signals";

export interface JournalProps {
  crumb: { label: string; items: { label: string; onPress?: () => void }[] };
  title: string;
  filter: {
    label: string;
    items: [string, JournalFilter][];
    value: JournalFilter;
    onChange(v: JournalFilter): void;
  };
  instrument: {
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onChange(v: string): void;
  };
  error: string | null;
  loading: boolean;
  record: {
    title: string;
    count: number | null;
    empty: string | null;
    groups: { key: string; label: string; rows: RecordRow[] }[];
    more: Press | null;
  };
  stats: { title: string; facts: FactProps[] };
  history: {
    title: string;
    count: number | null;
    empty: string | null;
    head: string[];
    withAccount: boolean;
    rows: HistoryLine[];
  };
}

const dotCls = {
  nw: "bg-accent",
  pos: "bg-positive",
  neg: "bg-negative",
  "": "bg-border",
} as const;

function PartView({ p }: { p: Part }) {
  if (p.kind === "link")
    return (
      <Button variant="link" size="md" onPress={p.onPress}>
        {p.label}
      </Button>
    );
  if (p.kind === "muted") return <span className="text-fg-muted">{p.text}</span>;
  return <>{p.text}</>;
}

function Record({ r }: { r: RecordRow }) {
  return (
    <>
      <div className="whitespace-nowrap py-1.25 text-fg-muted tabular-nums">{r.date}</div>
      <div className="flex justify-center py-1.25">
        <i aria-hidden="true" className={`mt-1.25 size-2 rounded-full ${dotCls[r.dot]}`} />
      </div>
      <div className="min-w-0 border-b border-border py-1.25">
        <b className="font-strong">{r.head}</b>
        {r.main && (
          <>
            {" · "}
            {r.main.map((p) => (
              <PartView key={p.key} p={p} />
            ))}
          </>
        )}
        {r.tail && (
          <span className="text-fg-muted">
            {r.tail.text}
            {r.tail.undo && (
              <>
                {" · "}
                <Button variant="link" size="md" onPress={r.tail.undo.onPress}>
                  {r.tail.undo.label}
                </Button>
              </>
            )}
          </span>
        )}
      </div>
    </>
  );
}

export function JournalView(p: JournalProps) {
  const h = p.history;
  return (
    <>
      <Crumb label={p.crumb.label} items={p.crumb.items} />
      <PageHead title={p.title}>
        <Seg
          quiet
          label={p.filter.label}
          items={p.filter.items}
          value={p.filter.value}
          onChange={p.filter.onChange}
        />
        <select
          value={p.instrument.value}
          onChange={(e) => p.instrument.onChange(e.target.value)}
          aria-label={p.instrument.label}
          className={selectCls()}
        >
          {p.instrument.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </PageHead>
      {p.error && (
        <div className="mb-4 rounded-control bg-negative px-3.5 py-2.5 text-on-accent">
          {p.error}
        </div>
      )}
      <Grid
        items={[
          {
            id: "log",
            span: 2,
            node: (
              <Widget
                title={p.record.title}
                count={p.record.count ?? undefined}
                tight
                footer={
                  <>
                    <span className="flex-1" />
                    {p.record.more && (
                      <Button variant="link" size="sm" onPress={p.record.more.onPress}>
                        {p.record.more.label}
                      </Button>
                    )}
                  </>
                }
              >
                {p.loading ? (
                  <Skeleton height={160} />
                ) : p.record.empty ? (
                  <div className={emptyCls}>{p.record.empty}</div>
                ) : (
                  <div className="grid grid-cols-[--spacing(17.5)_--spacing(2.5)_minmax(0,1fr)] gap-x-2.5 text-xs-plus">
                    {p.record.groups.map((g) => (
                      <Fragment key={g.key}>
                        <div className="col-span-full pt-2 pb-0.5 text-2xs uppercase tracking-label text-fg-muted">
                          {g.label}
                        </div>
                        {g.rows.map((r) => (
                          <Record key={r.key} r={r} />
                        ))}
                      </Fragment>
                    ))}
                  </div>
                )}
              </Widget>
            ),
          },
          {
            id: "stats",
            span: 1,
            node: (
              <Widget title={p.stats.title} tight>
                {p.loading ? (
                  <Skeleton height={120} />
                ) : (
                  <Facts items={p.stats.facts} columns={2} />
                )}
              </Widget>
            ),
          },
          {
            id: "history",
            span: 3,
            node: (
              <Widget title={h.title} count={h.count ?? undefined} tight flush>
                {p.loading ? (
                  <div className="px-4">
                    <Skeleton height={100} />
                  </div>
                ) : h.empty ? (
                  <div className="px-4 pb-3 text-center text-sm text-fg-muted">{h.empty}</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className={tableCls(true)}>
                      <thead>
                        <tr>
                          {h.head.map((t) => (
                            <th key={t} className={thCls()}>
                              {t}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {h.rows.map((r) => (
                          <tr key={r.id}>
                            <td className={`${tdCls()} tabular-nums`}>{r.since}</td>
                            <td className={`${tdCls()} whitespace-normal`}>
                              <PolDot polarity={r.polarity} />{" "}
                              {r.link ? (
                                <>
                                  <PartView p={r.link} />{" "}
                                  <span className="-mt-px block text-2xs-plus text-fg-muted">
                                    {r.words}
                                  </span>
                                </>
                              ) : (
                                r.words
                              )}
                            </td>
                            <td className={tdCls()}>
                              <PolarityText polarity={r.polarity} />
                            </td>
                            <td className={tdCls()}>{r.status}</td>
                            <td className={`${tdCls()} ${r.decision ? "" : "text-fg-muted"}`}>
                              {r.decision ?? "-"}
                            </td>
                            {h.withAccount && (
                              <td className={`${tdCls()} text-fg-muted`}>{r.account ?? ""}</td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Widget>
            ),
          },
        ]}
      />
    </>
  );
}
