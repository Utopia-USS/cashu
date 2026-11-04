import { Button, Card } from "@cashu/ui";
import type { ReactNode } from "react";
import { H } from "./HomeRail.strings.js";

export type RailGroup = "risk" | "chance" | "mixed" | "plan";
interface RailSubject {
  readonly id: string;
  readonly tile: string;
  readonly title: string;
  readonly text: string;
  readonly note?: string | null;
  readonly group: RailGroup;
  readonly onOpen: () => void;
}
interface RailAlert {
  readonly id: string;
  readonly tile: string;
  readonly title: string;
  readonly note?: string | null;
  readonly tag: string;
  readonly state: "near" | "met";
}
interface RailReview {
  readonly name: string;
  readonly items: number;
  readonly counts: Readonly<Partial<Record<RailGroup | "fix" | "proposal", number>>>;
  readonly onOpen: () => void;
}
export interface HomeRailViewProps {
  readonly privacy: boolean;
  readonly signals: {
    readonly available: boolean;
    /** Raw native Signals can still open when the review projection is unavailable or empty. */
    readonly navigationAvailable: boolean;
    readonly fresh: number;
    readonly left: number;
    readonly rows: readonly RailSubject[];
    readonly unchanged: number;
    readonly total: number;
    readonly reviewDue: boolean;
    readonly nextReviewDay: string | null;
    readonly review: RailReview | null;
    readonly onAll: () => void;
  };
  readonly alerts: {
    readonly available: boolean;
    readonly rows: readonly RailAlert[];
    readonly active: number;
    readonly onAll: () => void;
    readonly onNew: () => void;
  };
}

const groupTone: Readonly<Record<RailGroup, string>> = {
  risk: "text-negative",
  chance: "text-positive",
  mixed: "text-fg-muted",
  plan: "text-accent",
};
const pillTone: Readonly<Record<RailGroup | "fix" | "proposal", string>> = {
  risk: "bg-negative-bg text-negative",
  chance: "bg-positive-bg text-positive",
  mixed: "bg-warning-bg text-warning",
  plan: "bg-accent-muted text-accent",
  fix: "bg-warning-bg text-warning",
  proposal: "bg-accent-muted text-accent",
};

/** Shared row grammar: plain ticker tile, bold subject, one sentence, optional note/actions. */
export function HomeRailRowView({
  tile,
  title,
  text,
  note,
  right,
  onOpen,
}: {
  readonly tile: string;
  readonly title: string;
  readonly text?: string;
  readonly note?: string | null;
  readonly right?: ReactNode;
  readonly onOpen?: () => void;
}) {
  return (
    <div className="flex items-start gap-3 border-t border-border py-2 first:border-0">
      <span className="grid min-w-10 place-items-center rounded-sm bg-surface-sunken px-2 py-1 text-caption font-strong text-fg-muted">
        {tile}
      </span>
      <div className="min-w-0 flex-1 text-sm">
        {onOpen ? (
          <button
            type="button"
            className="block w-full text-left hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
            onClick={onOpen}
          >
            <strong>{title}</strong>
            {text && <span className="text-fg-muted"> {text}</span>}
            {note && <span className="block text-caption text-fg-muted">{note}</span>}
          </button>
        ) : (
          <>
            <strong>{title}</strong>
            {text && <span className="text-fg-muted"> {text}</span>}
            {note && <span className="block text-caption text-fg-muted">{note}</span>}
          </>
        )}
      </div>
      {right && <div className="flex shrink-0 items-center gap-1">{right}</div>}
    </div>
  );
}

export function HomeRailView({ privacy, signals, alerts }: HomeRailViewProps) {
  const groupLabel: Readonly<Record<RailGroup, string>> = {
    risk: H.risk,
    chance: H.chance,
    mixed: H.mixed,
    plan: H.plan,
  };
  const pillLabel: Readonly<Record<RailGroup | "fix" | "proposal", string>> = {
    ...groupLabel,
    fix: H.fix,
    proposal: H.proposal,
  };
  const lead =
    signals.fresh > 0 || signals.left > 0
      ? [
          signals.fresh > 0 ? H.fresh(signals.fresh) : null,
          signals.left > 0 ? H.left(signals.left) : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : `${H.nothingNew} ${signals.reviewDue ? H.reviewWaits : signals.nextReviewDay ? H.nextReview(signals.nextReviewDay) : ""}`;
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="native-investment-home-rail">
      <Card labelledBy="home-rail-signals" className="grid content-start gap-3">
        <header className="flex items-center justify-between gap-3">
          <h2 id="home-rail-signals" className="font-strong">
            {H.signals}
          </h2>
          <Button onPress={signals.onAll} disabled={privacy || !signals.navigationAvailable}>
            {H.all(signals.total)}
          </Button>
        </header>
        {privacy ? (
          <p>{H.hidden}</p>
        ) : !signals.available ? (
          <p>{H.unavailable}</p>
        ) : (
          <>
            <p className="text-sm font-strong">{lead}</p>
            {(["risk", "chance", "mixed", "plan"] as const).map((group) => {
              // The coordinator selects at most six subjects across all groups.
              const rows = signals.rows.filter((row) => row.group === group);
              return rows.length === 0 ? null : (
                <div key={group}>
                  <h3
                    className={`border-b border-border pb-1 text-caption font-strong uppercase ${groupTone[group]}`}
                  >
                    {groupLabel[group]}
                  </h3>
                  {rows.map((row) => (
                    <HomeRailRowView key={row.id} {...row} />
                  ))}
                </div>
              );
            })}
            {signals.review && signals.reviewDue && (
              <div className="grid gap-2 rounded-md bg-surface-sunken p-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <strong>{signals.review.name}</strong>
                  {signals.review.items > 0 && (
                    <span className="text-caption text-fg-muted">
                      {H.reviewItems(signals.review.items)}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {(Object.keys(pillLabel) as (keyof typeof pillLabel)[])
                    .filter((key) => (signals.review?.counts[key] ?? 0) > 0)
                    .map((key) => (
                      <span
                        key={key}
                        className={`rounded-full px-2 py-1 text-caption ${pillTone[key]}`}
                      >
                        {pillLabel[key]}: {signals.review?.counts[key]}
                      </span>
                    ))}
                </div>
                <Button onPress={signals.review.onOpen}>{H.openReview}</Button>
              </div>
            )}
            {signals.unchanged > 0 && (
              <p className="text-caption text-fg-muted">{H.unchanged(signals.unchanged)}</p>
            )}
          </>
        )}
      </Card>
      <Card labelledBy="home-rail-alerts" className="grid content-start gap-3">
        <header className="flex items-center justify-between gap-3">
          <h2 id="home-rail-alerts" className="font-strong">
            {H.alerts}
          </h2>
          <Button onPress={alerts.onNew} disabled={privacy || !alerts.available}>
            {H.addNew}
          </Button>
        </header>
        {privacy ? (
          <p>{H.hidden}</p>
        ) : !alerts.available ? (
          <p>{H.unavailable}</p>
        ) : alerts.rows.length === 0 ? (
          <p className="text-sm text-fg-muted">{H.noneClose(alerts.active)}</p>
        ) : (
          <div>
            {alerts.rows.map((row) => (
              <HomeRailRowView
                key={row.id}
                {...row}
                right={
                  <span
                    role="img"
                    className={`rounded-full px-2 py-1 text-caption font-strong ${row.state === "met" ? "bg-positive-bg text-positive" : "bg-warning-bg text-warning"}`}
                    aria-label={H.alertTag(row.tag, row.state === "met" ? H.met : H.near)}
                  >
                    {row.tag}
                  </span>
                }
              />
            ))}
          </div>
        )}
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
          <span className="text-caption text-fg-muted">
            {H.near} · {H.met}
          </span>
          <Button onPress={alerts.onAll} disabled={privacy || !alerts.available}>
            {H.all(alerts.active)}
          </Button>
        </footer>
      </Card>
    </div>
  );
}
