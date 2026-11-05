// AllocationWidget (ab24ab6 v2/Portfolio.tsx:267-355): `Widget#inv-alloc` with the band tag, the quiet view Seg
// (+ the Rachunki view's `ostrzezenia (n)` link and `+ Rachunek`), the donut + `.arow` rows (`.alloc`, `.wide`,
// `.acc`) and the portfolio priority banner.
import { Button, Donut, Drawer, Seg, Swatch, Tag, Widget } from "@cashu/ui";
import type { AllocationWidgetProps } from "./allocationModel.js";
import { emptyCls } from "./table.js";

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
const arow = "grid items-center gap-1.75 py-1 text-xs-plus tabular-nums";
const arowHead = "pb-0.5 text-3xs-plus uppercase tracking-label text-fg-muted";
const num = "whitespace-nowrap text-right";
const name = "overflow-hidden text-ellipsis whitespace-nowrap";

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
          {accounts && (
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
            </>
          )}
          {drawer && (
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
          )}
        </>
      }
    >
      {body.kind === "empty" ? (
        <div className={emptyCls}>{body.text}</div>
      ) : body.kind === "accounts" ? (
        <div className={allocGrid(wide)}>
          <Donut size={wide ? 128 : 112} {...body.donut} />
          <div>
            <div className={`${arow} ${arowHead} ${accCols(wide)}`}>
              <span />
              <span>{body.head.name}</span>
              <span className={num}>{body.head.now}</span>
              <span className={num}>{body.head.value}</span>
              <span className={`${num} ${wide ? "max-narrow:hidden" : ""}`}>
                {body.head.snapshot}
              </span>
            </div>
            {body.rows.map((r) => (
              <div key={r.key} className={`${arow} ${accCols(wide)}`} title={r.title}>
                <Swatch color={r.color} />
                <span className={name}>{r.name}</span>
                <span className={num}>{r.share}</span>
                <span className={num}>{r.value}</span>
                <span className={`${num} text-fg-muted ${wide ? "max-narrow:hidden" : ""}`}>
                  {r.onReconcile ? (
                    <Button
                      variant="link"
                      size="md"
                      className="text-warning!"
                      onPress={r.onReconcile}
                    >
                      {r.snapshot}
                    </Button>
                  ) : (
                    r.snapshot
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className={allocGrid(wide)}>
          <Donut size={wide ? 128 : 112} {...body.donut} />
          <div>
            <div className={`${arow} ${arowHead} ${rowCols(wide)}`}>
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
