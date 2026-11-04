import { Button, Card, DateText, VirtualList } from "@cashu/ui";
import type { HistoryLine } from "./alertModels.js";
import { decisionLabel, statusLabel } from "./labels.js";
import { G } from "./Signals.strings.js";
import { SignalValue } from "./SignalValue.js";

/** Triggered alerts of the last year, with the value each one observed, and the CSV export. */
export function AlertHistoryView({
  rows,
  canExport,
  onExport,
}: {
  rows: readonly HistoryLine[];
  canExport: boolean;
  onExport(): void;
}) {
  return (
    <Card>
      <header className="flex justify-between">
        <h2>{G.history}</h2>
        <Button disabled={!canExport} onPress={onExport}>
          {G.csv}
        </Button>
      </header>
      {rows.length === 0 ? (
        <p>{G.noRows}</p>
      ) : (
        <VirtualList
          items={rows}
          getKey={(row) => row.gid}
          label={G.history}
          estimateSize={62}
          rowClassName="flex flex-wrap justify-between gap-2 border-b border-border p-2"
          renderItem={(row) => (
            <>
              <DateText value={row.day} />
              <span>{row.message}</span>
              <span>
                {G.csvValue}: <SignalValue value={row.value} />
              </span>
              <span>{statusLabel(row.status)}</span>
              <span>{row.decision === null ? "-" : decisionLabel(row.decision)}</span>
            </>
          )}
        />
      )}
    </Card>
  );
}
