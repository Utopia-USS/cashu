// The assets first steps (ab24ab6 modules/assets/Steps.tsx), shared by the Majątek widget's empty form (compact)
// and the `setup/assets` page: a position (done with any row), a vehicle with its curve (optional). Statuses come
// from the rows (assetStepsModel), not from the server.
import { S } from "@cashu/i18n/assets/Steps.strings";
import { Button, type SetupStepItem, SetupSteps } from "@cashu/ui";
import type { AssetStepsModel } from "./assetStepsModel.js";

export function assetStepItems(
  model: AssetStepsModel,
  onAdd: (type: string) => void,
): SetupStepItem[] {
  const done = model.position === "done";
  return [
    {
      key: "position",
      status: model.position,
      title: S.position,
      hint: done ? S.positionsDone(model.count, model.totals) : S.positionHint,
      actions: done ? (
        <Button onPress={() => onAdd("property")}>{S.addAnother}</Button>
      ) : (
        <Button variant="primary" onPress={() => onAdd("property")}>
          {S.addPosition}
        </Button>
      ),
    },
    {
      key: "vehicle",
      status: model.vehicle,
      title: S.vehicle,
      optional: true,
      hint:
        model.vehicle === "done"
          ? model.vehicles.map((v) => S.vehicleDone(v.name, v.rate, v.loss)).join(" · ")
          : S.vehicleHint,
      actions: <Button onPress={() => onAdd("vehicle")}>{S.addVehicle}</Button>,
    },
  ];
}

export interface AssetsStepsViewProps {
  model: AssetStepsModel;
  compact?: boolean;
  onAdd(type: string): void;
}

export function AssetsStepsView({ model, compact, onAdd }: AssetsStepsViewProps) {
  return <SetupSteps compact={compact} steps={assetStepItems(model, onAdd)} />;
}
