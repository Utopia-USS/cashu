// The assets first steps (design/v3/first-steps section 10), shared by the Majątek widget's empty form (compact)
// and the `setup/assets` page: a position (done with any row), a vehicle with its curve (optional). Statuses come
// from the rows (logic.ts assetSteps), not from the server.
import { cur0s } from "../../format";
import { SetupSteps, type SetupStepItem } from "../../ui";
import type { ManualAsset } from "./api";
import { assetSteps, monthlyLoss, ratePct, sumByCurrency } from "./logic";
import { S } from "./Steps.strings.ts";

type StepRow = Pick<ManualAsset, "name" | "balance" | "currency" | "kind" | "type" | "depreciation">;

export function assetStepItems(rows: StepRow[], base: string, onAdd: (type: string) => void): SetupStepItem[] {
  const st = assetSteps(rows);
  const vehicles = rows.filter((r) => (r.kind === "vehicle" || r.type === "vehicle") && r.depreciation);
  const totals = sumByCurrency(rows, base).map(([c, v]) => cur0s(v, c)).join(" · ");
  return [
    {
      key: "position", status: st.position, title: S.position,
      hint: st.position === "done" ? S.positionsDone(rows.length, totals) : S.positionHint,
      actions: st.position === "done"
        ? <button className="btn" onClick={() => onAdd("property")}>{S.addAnother}</button>
        : <button className="btn primary" onClick={() => onAdd("property")}>{S.addPosition}</button>,
    },
    {
      key: "vehicle", status: st.vehicle, title: S.vehicle, optional: true,
      hint: st.vehicle === "done"
        ? vehicles.map((v) => S.vehicleDone(v.name, ratePct(v.depreciation!.annual_rate), cur0s(monthlyLoss(v.balance, v.depreciation) ?? 0, v.currency))).join(" · ")
        : S.vehicleHint,
      actions: <button className="btn" onClick={() => onAdd("vehicle")}>{S.addVehicle}</button>,
    },
  ];
}

export function AssetsSteps({ rows, base, compact, onAdd }: { rows: StepRow[]; base: string; compact?: boolean; onAdd: (type: string) => void }) {
  return <SetupSteps compact={compact} steps={assetStepItems(rows, base, onAdd)} />;
}
