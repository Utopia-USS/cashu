// Przegląd as layered tiles (design/desktop/overview/layered-tiles.html; the content of ab24ab6 core/Overview.tsx):
// no page-title row, a 12-column bento that starts under the top bar. The net worth tile leads (the figure, the
// change, "Net worth over time" with all its controls folded in, the hero facts as sub-tiles); the other tiles
// come from the screen and land where overviewLayout.ts puts them. Pure.
import { S as O } from "@cashu/i18n/core/Overview.strings";
import {
  AreaChart,
  Button,
  ChartLegend,
  Empty,
  emptyCls,
  Facts,
  LineChart,
  Seg,
  Select,
  StatementFigure,
  Tag,
  Widget,
} from "@cashu/ui";
import { type CSSProperties, type ReactNode, useState } from "react";
import type { NetWorthWidgetModel, Scope } from "./netWorthModel.js";
import { FootFacts, RichText } from "./OverviewWidgetsView.js";
import { bentoLayout, type Span } from "./overviewLayout.js";
import type { HeroModel, Link } from "./overviewModel.js";

/** A tile the screen hands over: its slot id and the widget node. */
export interface OverviewTile {
  id: string;
  node: ReactNode;
}

export interface OverviewViewProps {
  hero: HeroModel;
  /** "Net worth over time": its controls and chart live in the net worth tile. */
  netWorth: NetWorthWidgetModel;
  /** Beside the net worth tile (budget of the month, surplus -> contribution), in order. */
  side: readonly OverviewTile[];
  /** The middle row (modules not set up, investments, assets, loans), in order. */
  middle: readonly OverviewTile[];
  /** The bottom row: accounts, then subscriptions. */
  bottom: readonly OverviewTile[];
  /** No module enabled: the `Moduły` tile with the settings link. */
  noModules: Link | null;
  /** Slot id to ring once (a redirect focused it); every cell carries `data-slot` = its id. */
  flash?: string | null;
}

const spanCls: Record<Span, string> = {
  4: "col-span-4",
  6: "col-span-6",
  8: "col-span-8",
  12: "col-span-12",
};
const halfCls = { 6: "max-wide:col-span-6", 12: "max-wide:col-span-12" } as const;
const flashed = "[&>*]:outline [&>*]:outline-accent";

export function OverviewView({
  hero,
  netWorth,
  side,
  middle,
  bottom,
  noModules,
  flash = null,
}: OverviewViewProps) {
  const nodes = new Map<string, ReactNode>(
    [...side, ...middle, ...bottom].map((tile) => [tile.id, tile.node]),
  );
  nodes.set("hero", <NetWorthTile hero={hero} m={netWorth} />);
  if (noModules) nodes.set("nomods", <NoModulesTile link={noModules} />);
  const cells = bentoLayout({
    side: side.map((t) => t.id),
    middle: middle.map((t) => t.id),
    bottom: bottom.map((t) => t.id),
    banner: noModules ? "nomods" : null,
  });
  return (
    <div className="grid auto-rows-[minmax(--spacing(42),auto)] grid-cols-12 gap-3.5 text-md leading-widget">
      {cells.map((cell, k) => (
        <div
          key={cell.id}
          data-slot={cell.id}
          className={`tile-enter flex min-w-0 flex-col max-narrow:col-span-12 [&>*]:flex-1 ${spanCls[cell.span]} ${halfCls[cell.half]} ${cell.tall ? "row-span-2 max-wide:row-span-1" : ""} ${flash === cell.id ? flashed : ""}`}
          style={{ "--tile-i": k } as CSSProperties}
        >
          {nodes.get(cell.id)}
        </div>
      ))}
    </div>
  );
}

function NoModulesTile({ link }: { link: Link }) {
  return (
    <Widget title={O.modules} variant="quiet" layered>
      <Empty
        inWidget
        title={O.noModules}
        action={<Button onPress={link.onPress}>{link.label}</Button>}
      />
    </Widget>
  );
}

const footText = "text-xs text-fg-muted [&_b]:font-strong [&_b]:text-fg [&_b]:tabular-nums";

/** The net worth tile (old NetHero + NetWorthWidget): label with the month the change counts from and the other
 * currencies, the figure and the change, the chart with its type / scope / range / step controls, the legend and
 * the 12-month facts under it, the hero facts as sub-tiles. Scrubbing the chart shows that point in the figure
 * and its date and composition in the line under it; leaving restores the net worth. */
function NetWorthTile({ hero, m }: { hero: HeroModel; m: NetWorthWidgetModel }) {
  const [at, setAt] = useState<number | null>(null);
  const point = at == null ? null : m.point(at);
  const chart = m.chart;
  let body: ReactNode;
  if (chart === null) body = <div className={emptyCls}>{m.empty}</div>;
  else if (chart.kind === "line")
    body = (
      <LineChart
        label={chart.label}
        height={240}
        padL={60}
        padR={110}
        yFormat={chart.yFormat}
        xLabels={chart.xLabels}
        valueKind="amount"
        series={[{ values: chart.values, color: "accent", area: true, endLabel: chart.endLabel }]}
        tooltip={chart.tooltip}
        onScrub={setAt}
      />
    );
  else
    body = (
      <AreaChart
        label={chart.label}
        height={240}
        layers={chart.layers}
        totals={chart.totals}
        xLabels={chart.xLabels}
        yFormat={chart.yFormat}
        valueKind="amount"
        tooltip={chart.tooltip}
        onScrub={setAt}
      />
    );
  return (
    <Widget
      title={hero.label}
      variant="quiet"
      layered
      still
      tags={hero.since ? <span className="text-sm text-fg-muted">{hero.since}</span> : undefined}
      controls={hero.other ? <Tag title={hero.meta ?? undefined}>{hero.other}</Tag> : undefined}
      tight
    >
      <div className="flex h-full min-w-0 flex-col">
        <div className="mt-1">
          <span data-testid="net-worth">
            <StatementFigure size="tile" value={point ? point.value : hero.value} />
          </span>
        </div>
        <div className="mt-2.5 flex min-h-5 flex-wrap items-center gap-x-2.5 text-xs-plus text-fg-muted">
          {point ? (
            <>
              <span className="text-fg-secondary">{point.date}</span>
              {point.detail && <span>{point.detail}</span>}
            </>
          ) : (
            hero.delta && (
              <span className="font-strong">
                <RichText runs={hero.delta} />
              </span>
            )
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Seg
            quiet
            label={m.mode.label}
            items={m.mode.items}
            value={m.mode.value}
            onChange={m.mode.onChange}
          />
          {m.scope && (
            <Select
              label={m.scope.label}
              labelHidden
              value={m.scope.value}
              onChange={(v) => m.scope?.onChange(v as Scope)}
              options={m.scope.options}
            />
          )}
          <span className="flex-1" />
          <Seg
            quiet
            label={m.range.label}
            items={m.range.items}
            value={m.range.value}
            onChange={m.range.onChange}
          />
          <Seg
            quiet
            label={m.step.label}
            items={m.step.items}
            value={m.step.value}
            onChange={m.step.onChange}
          />
        </div>
        <div className="mt-2">{body}</div>
        {(chart?.kind === "stacked" || m.foot.length > 0) && (
          <div className={`mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 ${footText}`}>
            {chart?.kind === "stacked" && <ChartLegend items={chart.legend} />}
            <span className="flex-1" />
            <FootFacts items={m.foot} />
          </div>
        )}
        <Facts
          tile
          columns={Math.max(1, hero.facts.length)}
          className="mt-auto pt-3.5"
          items={hero.facts.map((f) => ({
            ...f,
            detail:
              typeof f.detail === "object" && f.detail !== null ? (
                <RichText runs={f.detail} />
              ) : (
                f.detail
              ),
          }))}
        />
      </div>
    </Widget>
  );
}
