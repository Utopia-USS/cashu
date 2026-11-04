import { Button, Card, DateText, VirtualList } from "@cashu/ui";
import { filterSelect } from "./controls.js";
import type { JournalFilter, JournalLine } from "./journalModels.js";
import { decisionLabel, statusLabel } from "./labels.js";
import { G } from "./Signals.strings.js";
import { Count } from "./SignalValue.js";
import type { JournalPageState } from "./useJournalPage.js";

/** The Journal page: decisions and signals by year and month, filtered by kind and instrument. */
export function JournalPageView(props: JournalPageState) {
  return (
    <Card>
      <div className="flex flex-wrap gap-2">
        <select
          className={filterSelect}
          aria-label={G.journalKind}
          value={props.filter}
          onChange={(event) => props.onFilter(event.target.value as JournalFilter)}
        >
          <option value="all">{G.all}</option>
          <option value="decisions">{G.filterDecisions}</option>
          <option value="signals">{G.filterSignals}</option>
        </select>
        <select
          className={filterSelect}
          aria-label={G.instrument}
          value={props.instrument}
          onChange={(event) => props.onInstrument(event.target.value)}
        >
          <option value="">{G.all}</option>
          {props.instruments.map((row) => (
            <option key={row.id} value={row.id}>
              {row.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-4 py-3">
        <span>
          {G.filterDecisions}: <Count value={props.decisions} />
        </span>
        <span>
          {G.filterSignals}: <Count value={props.signals} />
        </span>
      </div>
      {props.rows.length === 0 ? (
        <p>{G.noRows}</p>
      ) : (
        <VirtualList
          items={props.rows}
          getKey={(row) => row.id}
          label={G.journal}
          estimateSize={76}
          rowClassName="border-b border-border p-2"
          renderItem={(row) => <JournalRow {...props} row={row} />}
        />
      )}
    </Card>
  );
}

function JournalRow({ row, onOpenAsset, onUndo }: JournalPageState & { row: JournalLine }) {
  switch (row.kind) {
    case "year":
      return (
        <div className="flex flex-wrap gap-3">
          <strong>{row.year}</strong>
          <span>
            {G.filterDecisions}: <Count value={row.decisions} />
          </span>
          <span>
            {G.filterSignals}: <Count value={row.signals} />
          </span>
          {row.actions.map(([action, count]) => (
            <span key={action}>
              {decisionLabel(action)}: <Count value={count} />
            </span>
          ))}
        </div>
      );
    case "month":
      return <h3>{row.month}</h3>;
    case "decision": {
      const { instrument } = row;
      return (
        <>
          <DateText value={row.day} /> {G.filterDecisions}: {decisionLabel(row.action)} {row.reason}{" "}
          · {G.covered}: <Count value={row.linked} />
          {instrument && <Button onPress={() => onOpenAsset(instrument)}>{G.opens}</Button>}
          {row.undoable && <Button onPress={() => onUndo(row.id)}>{G.undo}</Button>}
        </>
      );
    }
    case "signal": {
      const { instrument } = row;
      return (
        <>
          <DateText value={row.day} /> {G.filterSignals}: {row.message} {statusLabel(row.status)} ·{" "}
          {row.decision === null ? G.noDecision : decisionLabel(row.decision)}
          {instrument && <Button onPress={() => onOpenAsset(instrument)}>{G.opens}</Button>}
        </>
      );
    }
  }
}
