import { Button } from "../controls/Button.js";
import { InstLabel } from "../instruments/InstTile.js";
import { AgentTag } from "../instruments/RowMarks.js";
import { Tag } from "../surfaces/Tag.js";

const MET = "✓";
const MISSED = "·";

export interface CandidateCriterion {
  text: string;
  met: boolean;
  /** Accessible name of the mark (`spełnione` / `niespełnione`). */
  mark: string;
}

/** The action row's state: the agent watches it, it is watched already, or Obserwuj / Odrzuć. */
export type CandidateState =
  | { kind: "agent"; label: string; title?: string }
  | { kind: "watched"; label: string }
  | {
      kind: "open";
      watch: { label: string; title: string; onPress(): void };
      dismiss: { label: string; title: string; onPress(): void };
      busy?: boolean;
    };

export interface CandidateCardProps {
  /** The note id (`data-note`). */
  id: number | string;
  name: string;
  /** The ticker monogram of the tile. */
  monogram: string;
  /** Muted second line of the label (the venue, or the symbol). */
  sub?: string;
  /** The entry-type tag on the right of the head. */
  entry?: string | null;
  /** Met / not met criteria; empty = the `title` line instead. */
  criteria: readonly CandidateCriterion[];
  /** The context line under the criteria (or under the title). */
  context?: string | null;
  /** The note title (shown when there are no criteria). */
  title: string;
  /** A dismissed candidate: the dismissed tag, its line and the optional restore link; no action row. */
  dismissed?: { tag: string; line: string; restore?: { label: string; onPress(): void } } | null;
  state: CandidateState;
  /** `n źródeł · d.m` on the right of the action row. */
  sources: string;
}

const line =
  "text-xs-plus leading-widget text-fg-muted [&_b]:font-strong [&_b]:text-fg [&_b]:tabular-nums";

/** A research candidate (old research primitives `.cand`): name + venue, entry-type tag, the criteria (each a
 * measured fact with the strategy's threshold), a context line, `Obserwuj` / `Odrzuć`, sources and date. No price,
 * no target, no size: a candidate is never a position. Cards in a list: `className` margins are the caller's. */
export function CandidateCard(p: CandidateCardProps & { className?: string }) {
  return (
    <div
      data-note={p.id}
      className={`grid gap-1.25 rounded-md border border-border bg-surface-raised px-3 py-2.5 ${p.dismissed ? "opacity-60" : ""} ${p.className ?? ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <InstLabel density="compact" monogram={p.monogram} name={p.name} sub={p.sub} />
        <span className="flex-1" />
        {p.entry && <Tag>{p.entry}</Tag>}
      </div>
      {p.dismissed ? (
        <>
          <div>
            <Tag solid>{p.dismissed.tag}</Tag>
          </div>
          <div className={line}>{p.dismissed.line}</div>
          {p.dismissed.restore && (
            <div>
              <Button variant="link" size="lg" onPress={p.dismissed.restore.onPress}>
                {p.dismissed.restore.label}
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          {p.criteria.length > 0 ? (
            <div className="my-0.5 grid gap-0.75 text-xs-plus">
              {p.criteria.map((c) => (
                <span
                  key={c.text}
                  className={`flex items-baseline gap-1.75 ${c.met ? "" : "text-fg-muted"}`}
                >
                  <i
                    role="img"
                    aria-label={c.mark}
                    className={`w-3 flex-none text-2xs not-italic ${c.met ? "text-positive" : "text-fg-muted"}`}
                  >
                    {c.met ? MET : MISSED}
                  </i>
                  {c.text}
                </span>
              ))}
            </div>
          ) : (
            <div className={line}>{p.title}</div>
          )}
          {p.context && <div className={line}>{p.context}</div>}
        </>
      )}
      {!p.dismissed && (
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {p.state.kind === "agent" ? (
            <AgentTag full text={p.state.label} title={p.state.title} />
          ) : p.state.kind === "watched" ? (
            <Tag solid>{p.state.label}</Tag>
          ) : (
            <>
              <Button
                variant="primary"
                size="sm"
                disabled={p.state.busy}
                title={p.state.watch.title}
                onPress={p.state.watch.onPress}
              >
                {p.state.watch.label}
              </Button>
              <Button
                size="sm"
                disabled={p.state.busy}
                title={p.state.dismiss.title}
                onPress={p.state.dismiss.onPress}
              >
                {p.state.dismiss.label}
              </Button>
            </>
          )}
          <span className="flex-1" />
          <span className="text-2xs-plus text-fg-muted">{p.sources}</span>
        </div>
      )}
    </div>
  );
}
