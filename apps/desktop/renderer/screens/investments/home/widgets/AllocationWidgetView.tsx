// AllocationWidget (ab24ab6 v2/Portfolio.tsx:267-355): `Widget#inv-alloc` with the band tag, the quiet view Seg
// (+ the Rachunki view's `ostrzezenia (n)` link and `+ Rachunek`), the donut + `.arow` rows (`.alloc`, `.wide`,
// `.acc`) and the portfolio priority banner.
import { Button, Donut, Drawer, emptyCls, Seg, Swatch, Tag, Widget } from "@cashu/ui";
import type { AccountsWidgetProps, AllocationWidgetProps } from "./allocationModel.js";

// `.w .alloc` (112px donut column, gap 14) / `.alloc.wide` (128px, gap 20; back to 112 / 14 at <= 760).
const allocGrid = (wide: boolean) =>
  `grid items-center ${
    wide
      ? "grid-cols-[--spacing(32)_minmax(0,1fr)] gap-5 max-narrow:grid-cols-[--spacing(28)_minmax(0,1fr)] max-narrow:gap-3.5"
      : "grid-cols-[--spacing(28)_minmax(0,1fr)] gap-3.5"
  }`;
// `.arow` columns: swatch | name | teraz | cel | dryf (| wartosc | do celu when wide; dropped at <= 760).
const rowCols = (wide: boolean) =>
  wide
    ? "grid-cols-[--spacing(2.5)_minmax(0,1fr)_--spacing(15)_--spacing(11)_--spacing(16)_--spacing(24)_--spacing(24)] max-narrow:grid-cols-[--spacing(2.5)_minmax(0,1fr)_--spacing(13)_--spacing(10)_--spacing(14.5)]"
    : "grid-cols-[--spacing(2.5)_minmax(0,1fr)_--spacing(13)_--spacing(10)_--spacing(14.5)]";
// `.alloc.acc .arow`: swatch | rachunek | teraz | wartosc | snapshot (snapshot dropped at <= 760 when wide).
const accCols = (wide: boolean) =>
  wide
    ? "grid-cols-[--spacing(2.5)_minmax(0,1fr)_--spacing(15)_--spacing(24)_--spacing(30)] max-narrow:grid-cols-[--spacing(2.5)_minmax(0,1fr)_--spacing(13)_--spacing(21.5)]"
    : "grid-cols-[--spacing(2.5)_minmax(0,1fr)_--spacing(13)_--spacing(21)_--spacing(21)]";
const arowBase = "grid items-center gap-1.75 pt-1 tabular-nums";
// `.arow` 12.5px rows; `.arow.head` 10.5px muted uppercase .05em with a 2px bottom padding.
const arow = `${arowBase} pb-1 text-xs-plus`;
const arowHead = `${arowBase} pb-0.5 text-3xs-plus uppercase tracking-label text-fg-muted`;
const num = "whitespace-nowrap text-right";
const name = "overflow-hidden text-ellipsis whitespace-nowrap";

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

/** AccountsRows (Portfolio.tsx:236-265): the donut by account and `rachunek | teraz | wartosc | snapshot`. */
function AccountsBody({ body, wide }: { body: Exclude<Body, { kind: "rows" }>; wide: boolean }) {
  if (body.kind === "empty") return <div className={emptyCls}>{body.text}</div>;
  return (
    <div className={allocGrid(wide)}>
      <Donut size={wide ? 128 : 112} {...body.donut} />
      <div>
        <div className={`${arowHead} ${accCols(wide)}`}>
          <span />
          <span>{body.head.name}</span>
          <span className={num}>{body.head.now}</span>
          <span className={num}>{body.head.value}</span>
          <span className={`${num} ${wide ? "max-narrow:hidden" : ""}`}>{body.head.snapshot}</span>
        </div>
        {body.rows.map((r) => (
          <div key={r.key} className={`${arow} ${accCols(wide)}`} title={r.title}>
            <Swatch color={r.color} />
            <span className={name}>{r.name}</span>
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
  const wideOnly = wide ? "max-narrow:hidden" : "hidden";
  return (
    <Widget
      title={title}
      id="inv-alloc"
      tags={
        tag && (
          <Tag tone={tag.tone} title={tag.title}>
            {tag.text}
          </Tag>
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
        <div className={allocGrid(wide)}>
          <Donut size={wide ? 128 : 112} {...body.donut} />
          <div>
            <div className={`${arowHead} ${rowCols(wide)}`}>
              <span />
              <span>{body.head.name}</span>
              <span className={num}>{body.head.now}</span>
              <span className={num} title={body.head.target.title}>
                {body.head.target.text}
              </span>
              <span className={num} title={body.head.drift.title}>
                {body.head.drift.text}
              </span>
              <span className={`${num} ${wideOnly}`}>{body.head.value}</span>
              <span className={`${num} ${wideOnly}`}>{body.head.toTarget}</span>
            </div>
            {body.rows.map((r) => (
              <div key={r.key} className={`${arow} ${rowCols(wide)}`}>
                <Swatch color={r.color} />
                <span className={name} title={r.name}>
                  {r.name}
                </span>
                <span className={num}>{r.now}</span>
                <span className={`${num} text-fg-muted`}>{r.target}</span>
                <span className={`${num} ${r.out ? "text-warning" : ""}`}>{r.drift}</span>
                <span className={`${num} ${wideOnly}`}>{r.value}</span>
                <span className={`${num} ${wideOnly}`}>{r.toTarget}</span>
              </div>
            ))}
          </div>
          {body.priority && (
            <div
              className={`col-span-full mt-0.5 flex items-baseline gap-1.5 rounded-control border bg-chip px-2.5 py-2 text-xs leading-cozy ${
                body.priority.warn
                  ? "border-[color-mix(in_srgb,var(--color-warning)_45%,var(--color-border))] text-warning"
                  : "border-border text-fg-muted"
              }`}
            >
              <b className="whitespace-nowrap text-fg">{body.priority.label}</b>
              <span>{body.priority.text}</span>
            </div>
          )}
        </div>
      )}
    </Widget>
  );
}
