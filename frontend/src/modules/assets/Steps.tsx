// The assets first steps (design/v3/first-steps section 10), shared by the Majątek widget's empty form (compact)
// and the `setup/assets` page: a position (done with any row), a vehicle with its curve (optional). Statuses come
// from the rows (logic.ts assetSteps), not from the server.
import { cur0s, plural } from "../../format";
import { SetupSteps, type SetupStepItem } from "../../ui";
import type { ManualAsset } from "./api";
import { assetSteps, monthlyLoss, ratePct, sumByCurrency } from "./logic";

type StepRow = Pick<ManualAsset, "name" | "balance" | "currency" | "kind" | "type" | "depreciation">;

export function assetStepItems(rows: StepRow[], base: string, onAdd: (type: string) => void): SetupStepItem[] {
  const st = assetSteps(rows);
  const vehicles = rows.filter((r) => (r.kind === "vehicle" || r.type === "vehicle") && r.depreciation);
  const totals = sumByCurrency(rows, base).map(([c, v]) => cur0s(v, c)).join(" · ");
  return [
    {
      key: "position", status: st.position, title: "Pozycja",
      hint: st.position === "done" ? `${plural(rows.length, "pozycja", "pozycje", "pozycji")} · razem ${totals}` : "Mieszkanie, działka, inne aktywa: nazwa, wartość, waluta.",
      actions: st.position === "done"
        ? <button className="btn" onClick={() => onAdd("property")}>Dodaj kolejną</button>
        : <button className="btn primary" onClick={() => onAdd("property")}>Dodaj pozycję</button>,
    },
    {
      key: "vehicle", status: st.vehicle, title: "Auto", optional: true,
      hint: st.vehicle === "done"
        ? vehicles.map((v) => `${v.name} · ${ratePct(v.depreciation!.annual_rate)} % / rok · -${cur0s(monthlyLoss(v.balance, v.depreciation) ?? 0, v.currency)} / mies.`).join(" · ")
        : "Cena i data zakupu, roczny spadek; wartość liczy się sama.",
      actions: <button className="btn" onClick={() => onAdd("vehicle")}>Dodaj auto</button>,
    },
  ];
}

export function AssetsSteps({ rows, base, compact, onAdd }: { rows: StepRow[]; base: string; compact?: boolean; onAdd: (type: string) => void }) {
  return <SetupSteps compact={compact} steps={assetStepItems(rows, base, onAdd)} />;
}
