import { Money as MoneyValue } from "@cashu/domain";
import { S as A } from "@cashu/i18n/assets/index.strings";
import { S } from "@cashu/i18n/assets/Steps.strings";
import { Money } from "@cashu/ui";
import { L } from "../loans/Loans.strings.js";
import { AssetDrawerView } from "../overview/AssetsWidgetView.js";
import type { AssetDrawerState } from "../overview/useAssetDrawer.js";

export interface AssetsStartViewProps {
  state: AssetDrawerState;
  today: string;
  baseCurrency: string;
  privacy: boolean;
  onOverviewOpened(): void;
}
/** First-step actions reuse the same closed native asset drawer as Overview. */
export function AssetsStartView({
  state,
  today,
  baseCurrency,
  privacy,
  onOverviewOpened,
}: AssetsStartViewProps) {
  const vehicles = state.rows.filter((row) => row.kind === "vehicle" && row.depreciation !== null);
  return (
    <main className="grid gap-6 p-6" data-testid="native-assets-start">
      <header className="flex justify-between gap-3">
        <h1 className="text-headline font-strong">{A.name}</h1>
        <button type="button" onClick={onOverviewOpened}>
          {L.overview}
        </button>
      </header>
      <section className="rounded-lg border border-border bg-surface-raised p-6">
        <h2>
          {S.position} · {state.rows.length ? L.ready : L.notReady}
        </h2>
        <p className="my-3 text-fg-muted">
          {state.rows.length ? L.positions(state.rows.length) : S.positionHint}
        </p>
        {state.orderedTotals.map(([currency, amount]) => (
          <Money key={currency} value={new MoneyValue(amount, currency)} />
        ))}
        <button
          type="button"
          disabled={privacy || state.busy}
          onClick={() => state.openNew("property", baseCurrency)}
        >
          {state.rows.length ? S.addAnother : S.addPosition}
        </button>
      </section>
      <section className="rounded-lg border border-border bg-surface-raised p-6">
        <h2>
          {S.vehicle} · {L.optional} · {vehicles.length ? L.ready : L.notReady}
        </h2>
        <p className="my-3 text-fg-muted">{S.vehicleHint}</p>
        {!privacy &&
          vehicles.slice(0, 50).map((row) => (
            <p key={row.gid} className="text-caption text-fg-muted">
              {row.name} · {state.displayRows.find((display) => display.gid === row.gid)?.lossLine}
            </p>
          ))}
        <button
          type="button"
          disabled={privacy || state.busy}
          onClick={() => state.openNew("vehicle", baseCurrency)}
        >
          {S.addVehicle}
        </button>
      </section>
      <AssetDrawerView state={state} today={today} privacy={privacy} />
    </main>
  );
}
