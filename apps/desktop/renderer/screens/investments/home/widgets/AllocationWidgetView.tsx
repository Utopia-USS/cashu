// AllocationWidget (ab24ab6 v2/Portfolio.tsx:267-355, laid out as design V5): the quiet card `#inv-alloc` with the
// band status (a dot and its words), the quiet view Seg (+ the Rachunki view's `ostrzezenia (n)` link and
// `+ Rachunek`), the donut + hairline rows (a hovered row lights its segment and shows its share in the centre, a
// hovered segment lights its row) and the portfolio priority as a plain line with a dot. The light grid's
// AccountsWidget keeps the eyebrow card with the same rows.
import { Button, Donut, type DonutProps, Drawer, emptyCls, Seg, Swatch, Widget } from "@cashu/ui";
import { useState } from "react";
import type { AccountsWidgetProps, AllocationWidgetProps } from "./allocationModel.js";

// Design V5: donut 128px | rows (back to 112px at <= 760px), 28px apart.
const allocGrid = (wide: boolean) =>
  `grid items-center ${
    wide
      ? "grid-cols-[--spacing(32)_minmax(0,1fr)] gap-x-7 gap-y-4 max-narrow:grid-cols-[--spacing(28)_minmax(0,1fr)] max-narrow:gap-x-3.5"
      : "grid-cols-[--spacing(28)_minmax(0,1fr)] gap-x-3.5 gap-y-3"
  }`;
// Rows: name | now / target | drift | value | to target (value and to-target only when wide, dropped at <= 760).
const rowCols = (wide: boolean) =>
  wide
    ? "grid-cols-[minmax(0,1fr)_--spacing(23)_--spacing(16)_--spacing(25)_--spacing(19)] max-narrow:grid-cols-[minmax(0,1fr)_--spacing(23)_--spacing(16)]"
    : "grid-cols-[minmax(0,1fr)_--spacing(23)_--spacing(16)]";
// Classes / regions: name | now | value.
const shareCols = (wide: boolean) =>
  wide
    ? "grid-cols-[minmax(0,1fr)_--spacing(23)_--spacing(25)] max-narrow:grid-cols-[minmax(0,1fr)_--spacing(23)]"
    : "grid-cols-[minmax(0,1fr)_--spacing(23)]";
// Accounts: account | now | value | snapshot (snapshot dropped at <= 760 when wide).
const accCols = (wide: boolean) =>
  wide
    ? "grid-cols-[minmax(0,1fr)_--spacing(15)_--spacing(25)_--spacing(30)] max-narrow:grid-cols-[minmax(0,1fr)_--spacing(13)_--spacing(21.5)]"
    : "grid-cols-[minmax(0,1fr)_--spacing(13)_--spacing(21)_--spacing(21)]";
const rowBase = "grid items-center gap-3 tabular-nums";
// Hairline rows about 36px, the hovered (or lit) one on the subtle fill.
const arow = (lit: boolean) =>
  `${rowBase} h-9 border-t border-border text-sm transition-colors duration-150 ${lit ? "bg-subtle" : ""}`;
// The sentence-case column header (design V5): 12px muted, no uppercase.
const arowHead = `${rowBase} h-6.5 text-xs text-fg-muted`;
const num = "whitespace-nowrap text-right";
const name = "flex min-w-0 items-center gap-2.5 overflow-hidden whitespace-nowrap";
const ellipsis = "min-w-0 overflow-hidden text-ellipsis";

type Body = AllocationWidgetProps["body"];

/** The Rachunki controls: `ostrzezenia (n)` (opens the data warnings drawer) and `+ Rachunek`. */
function AccountsControls({ accounts, drawer }: Pick<AccountsWidgetProps, "accounts" | "drawer">) {
  return (
    <>
      {accounts.warnings && (
        <Button
          variant="link"
          size="md"
          title={accounts.warnings.title}
          onPress={accounts.warnings.onOpen}
        >
          {accounts.warnings.text}
        </Button>
      )}
      <Button size="sm" onPress={accounts.add.onPress}>
        {accounts.add.text}
      </Button>
      {drawer && <WarningsDrawer drawer={drawer} />}
    </>
  );
}

function WarningsDrawer({ drawer }: { drawer: NonNullable<AccountsWidgetProps["drawer"]> }) {
  return (
    <Drawer title={drawer.title} label={drawer.title} onClose={drawer.onClose} width={520}>
      <div className="mb-2.5 grid gap-1 text-xs-plus text-warning">
        {drawer.lines.map((line) => (
          <span key={line.text} title={line.title}>
            {line.text} ·{" "}
            <Button variant="link" size="md" onPress={line.onLink}>
              {line.link}
            </Button>
          </span>
        ))}
      </div>
    </Drawer>
  );
}

/** The donut with a row lit: its segment stands out and the centre shows that row's share and name. */
function centreOf(
  donut: DonutProps,
  row: { now: string; name: string } | undefined,
): DonutProps["center"] {
  return row ? { title: row.now, caption: row.name } : donut.center;
}

/** AccountsRows (Portfolio.tsx:236-265): the donut by account and `account | now | value | snapshot`. */
function AccountsBody({ body, wide }: { body: Exclude<Body, { kind: "rows" }>; wide: boolean }) {
  const [lit, setLit] = useState<number | null>(null);
  if (body.kind === "empty") return <div className={emptyCls}>{body.text}</div>;
  const index = lit == null ? -1 : body.rows.findIndex((r) => r.key === lit);
  const litRow = body.rows[index];
  return (
    <div className={allocGrid(wide)}>
      <Donut
        size={wide ? 128 : 112}
        {...body.donut}
        center={centreOf(body.donut, litRow && { now: litRow.share, name: litRow.name })}
        focus={index < 0 ? null : index}
        onSegmentHover={(i) => setLit(i == null ? null : (body.rows[i]?.key ?? null))}
      />
      <div>
        <div className={`${arowHead} ${accCols(wide)}`}>
          <span>{body.head.name}</span>
          <span className={num}>{body.head.now}</span>
          <span className={num}>{body.head.value}</span>
          <span className={`${num} ${wide ? "max-narrow:hidden" : ""}`}>{body.head.snapshot}</span>
        </div>
        {body.rows.map((r) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: hover only lights the donut segment; no action.
          <div
            key={r.key}
            className={`${arow(r.key === lit)} ${accCols(wide)}`}
            title={r.title}
            onMouseEnter={() => setLit(r.key)}
            onMouseLeave={() => setLit(null)}
          >
            <span className={name}>
              <Swatch color={r.color} size="xs" />
              <span className={ellipsis}>{r.name}</span>
            </span>
            <span className={num}>{r.share}</span>
            <span className={num}>{r.value}</span>
            <span className={`${num} text-fg-muted ${wide ? "max-narrow:hidden" : ""}`}>
              {r.stale ? <span className="text-warning">{r.snapshot}</span> : r.snapshot}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** AccountsWidget (Portfolio.tsx:357-367): `Widget#inv-accounts`, the Rachunki controls and rows, not wide. */
export function AccountsWidgetView({ title, accounts, body, drawer }: AccountsWidgetProps) {
  return (
    <Widget
      title={title}
      id="inv-accounts"
      tight
      controls={<AccountsControls accounts={accounts} drawer={drawer} />}
    >
      {body.kind === "rows" ? null : <AccountsBody body={body} wide={false} />}
    </Widget>
  );
}

export function AllocationWidgetView({
  title,
  wide,
  tag,
  viewLabel,
  views,
  view,
  onView,
  accounts,
  body,
  drawer,
}: AllocationWidgetProps) {
  return (
    <Widget
      variant="quiet"
      title={title}
      id="inv-alloc"
      tags={
        tag && (
          <span
            title={tag.title}
            className="inline-flex items-center gap-1.75 text-xs-plus text-fg-secondary"
          >
            <i
              aria-hidden="true"
              className={`size-1.5 rounded-full ${tag.tone === "warning" ? "bg-warning" : "bg-positive"}`}
            />
            {tag.text}
          </span>
        )
      }
      controls={
        <>
          <Seg quiet label={viewLabel} value={view} onChange={onView} items={views} />
          {accounts && <AccountsControls accounts={accounts} drawer={drawer} />}
          {!accounts && drawer && <WarningsDrawer drawer={drawer} />}
        </>
      }
    >
      {body.kind !== "rows" ? (
        <AccountsBody body={body} wide={wide} />
      ) : (
        <AllocRows body={body} wide={wide} />
      )}
    </Widget>
  );
}

function AllocRows({ body, wide }: { body: Extract<Body, { kind: "rows" }>; wide: boolean }) {
  const [lit, setLit] = useState<string | null>(null);
  const buckets = body.head.drift.text !== "";
  const cols = buckets ? rowCols(wide) : shareCols(wide);
  const wideOnly = wide ? "max-narrow:hidden" : "hidden";
  const index = lit == null ? -1 : body.rows.findIndex((r) => r.key === lit);
  const priority = body.priority;
  return (
    <div className={allocGrid(wide)}>
      <Donut
        size={wide ? 128 : 112}
        {...body.donut}
        center={centreOf(body.donut, body.rows[index])}
        focus={index < 0 ? null : index}
        onSegmentHover={(i) => setLit(i == null ? null : (body.rows[i]?.key ?? null))}
      />
      <div>
        <div className={`${arowHead} ${cols}`}>
          <span>{body.head.name}</span>
          <span className={num} title={body.head.target.title}>
            {body.head.now}
          </span>
          {buckets && (
            <span className={num} title={body.head.drift.title}>
              {body.head.drift.text}
            </span>
          )}
          <span className={`${num} ${wideOnly}`}>{body.head.value}</span>
          {buckets && <span className={`${num} ${wideOnly}`}>{body.head.toTarget}</span>}
        </div>
        {body.rows.map((r) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: hover only lights the donut segment; no action.
          <div
            key={r.key}
            className={`${arow(r.key === lit)} ${cols}`}
            onMouseEnter={() => setLit(r.key)}
            onMouseLeave={() => setLit(null)}
          >
            <span className={name} title={r.name}>
              <Swatch color={r.color} size="xs" />
              <span className={ellipsis}>{r.name}</span>
            </span>
            <span className={num}>
              {r.now}
              {r.target !== "" && <span className="ml-1 text-xs text-fg-muted">/ {r.target}</span>}
            </span>
            {buckets && (
              <span className={`${num} ${r.out ? "text-warning" : "text-fg-muted"}`}>
                {r.drift}
              </span>
            )}
            <span className={`${num} ${wideOnly}`}>{r.value}</span>
            {buckets && (
              <span className={`${num} text-fg-secondary ${wideOnly}`}>{r.toTarget}</span>
            )}
          </div>
        ))}
      </div>
      {priority && (
        <p
          className="col-span-full m-0 mt-0.5 flex items-baseline gap-2.5 text-xs-plus leading-normal text-fg-secondary"
          onMouseEnter={() => setLit(priority.rowKey)}
          onMouseLeave={() => setLit(null)}
        >
          <span className="relative -top-px self-center">
            <Swatch color={priority.color} size="dot" />
          </span>
          <span>
            <b className="font-medium text-fg">{priority.label}.</b> {priority.text}
          </span>
        </p>
      )}
    </div>
  );
}
