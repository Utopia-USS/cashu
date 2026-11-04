import { Button, Card, DateText } from "@cashu/ui";
import { decisionLabel, runStatusLabel, toneLabel } from "./labels.js";
import { G } from "./Signals.strings.js";
import { Count } from "./SignalValue.js";
import type { SignalsRailState } from "./useSignalsScreen.js";

/** The compact Signals rail: open groups, the last check and quick links to the pages. */
export function SignalsHomeRailView({
  available,
  privacy,
  total,
  rows,
  summary,
  onOpenAll,
  onOpenRow,
  onOpenPage,
  onOpenReview,
}: SignalsRailState) {
  return (
    <Card testID="native-signals-rail">
      <header className="flex items-center justify-between">
        <h2>{G.signals}</h2>
        <Button onPress={onOpenAll}>
          {G.all} <Count value={total} />
        </Button>
      </header>
      {!available ? (
        <p>{privacy ? G.privacy : G.unavailable}</p>
      ) : rows.length === 0 ? (
        <p>{G.empty}</p>
      ) : (
        <div className="grid gap-2 py-2">
          {rows.map((row) => (
            <Button
              key={row.key}
              className="flex items-center justify-between text-left"
              onPress={() => onOpenRow(row.focus)}
            >
              <span>{row.label}</span>
              <span>
                <Count value={row.live} /> {toneLabel(row.tone)}
              </span>
            </Button>
          ))}
        </div>
      )}
      {summary && (
        <div className="grid gap-1 py-2 text-sm">
          <p>
            {G.lastRun}:{" "}
            {summary.lastRun ? (
              <>
                <DateText value={summary.lastRun.day} /> · {runStatusLabel(summary.lastRun.status)}
              </>
            ) : (
              G.neverRun
            )}
          </p>
          <p>
            {G.expiredSignals}: <Count value={summary.expired} />
          </p>
          {summary.recent.length > 0 && (
            <div>
              <strong>{G.recentDecisions}</strong>
              {summary.recent.map((row) => (
                <p key={row.gid}>
                  <DateText value={row.day} /> · {decisionLabel(row.action)} · {row.reason}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2 border-t border-border pt-2">
        <Button onPress={() => onOpenPage("alerts")}>{G.alerts}</Button>
        <Button onPress={() => onOpenPage("watchlist")}>{G.watchlist}</Button>
        <Button onPress={() => onOpenPage("journal")}>{G.journal}</Button>
        {onOpenReview && <Button onPress={onOpenReview}>{G.review}</Button>}
      </div>
    </Card>
  );
}
