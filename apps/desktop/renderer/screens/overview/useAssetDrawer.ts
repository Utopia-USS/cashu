import { assets, D } from "@cashu/domain";
import { normalizeNumberInput } from "@cashu/i18n";
import { S as A } from "@cashu/i18n/assets/AssetsWidget.strings";
import {
  createOverviewAsset,
  removeOverviewAsset,
  restoreOverviewAsset,
  updateAssetDetails,
} from "@cashu/store";
import { overviewQueries } from "@cashu/store/overview";
import { useCommand, useQuery } from "@cashu/store-react";
import { curvePreview, monthlyLoss, ratePct, valuationLabel } from "@cashu/ui-logic/assets/logic";
import { cur0s, round0, TYPE_LABEL } from "@cashu/ui-logic/core/format";
import { useState } from "react";
import { W } from "./OverviewWidgets.strings.js";

const queries = overviewQueries({ prices: null });
const assetType = (value: string): "property" | "vehicle" | "investment" | "other" | null => {
  switch (value) {
    case "property":
    case "vehicle":
    case "investment":
    case "other":
      return value;
    default:
      return null;
  }
};
type Form = {
  name: string;
  type: string;
  value: string;
  currency: string;
  onDate: string;
  note: string;
  purchasePrice: string;
  purchaseDate: string;
  annualRate: string;
  floor: string;
};

const decimal = (text: string, allowZero = true): string | null => {
  try {
    const value = D(normalizeNumberInput(text));
    return value.lt(D("0")) || (!allowZero && value.isZero()) ? null : value.format("f");
  } catch {
    return null;
  }
};

/** Asset changes are closed native commands against the current authenticated vault. */
export function useAssetDrawer(today: string, baseCurrency: string) {
  const positionTypes = assets.SETUP_POSITION_TYPES.map((value) => ({
    value,
    label: TYPE_LABEL[value] ?? value,
  }));
  const rows = useQuery(queries.assets, { today });
  const displayRows = rows.map((row) => {
    const loss =
      row.kind === "vehicle" && row.depreciation !== null
        ? monthlyLoss(row.amount?.toFloat(), {
            purchase_price: row.depreciation.purchasePrice.toFloat(),
            purchase_date: row.depreciation.purchaseDate,
            annual_rate: row.depreciation.annualRate.toFloat() / 100,
            floor: row.depreciation.floor?.toFloat() ?? null,
          })
        : null;
    return {
      ...row,
      loss,
      lossLine:
        loss === null
          ? null
          : round0(loss) > 0
            ? A.lossPerMonth(cur0s(loss, row.currency))
            : A.floorReached,
      valuation:
        row.kind === "vehicle"
          ? {
              text: `${A.curve}${row.depreciation === null ? "" : A.perYear(ratePct(row.depreciation.annualRate.toFloat() / 100))}`,
              stale: false,
            }
          : valuationLabel(row.asOf, today),
    };
  });
  const totals = new Map<string, ReturnType<typeof D>>();
  for (const row of rows)
    totals.set(row.currency, (totals.get(row.currency) ?? D("0")).add(row.amount ?? D("0")));
  const orderedTotals = [...totals].sort((a, b) =>
    a[0] === baseCurrency ? -1 : b[0] === baseCurrency ? 1 : a[0].localeCompare(b[0]),
  );
  const baseVehicles = displayRows.filter(
    (row) => row.kind === "vehicle" && row.depreciation !== null && row.currency === baseCurrency,
  );
  const baseLosses = baseVehicles.flatMap((row) => (row.loss === null ? [] : [row.loss]));
  const lossTotal = baseLosses.reduce((sum, value) => sum + value, 0);
  const lossSummary =
    baseLosses.length > 0 && round0(lossTotal) > 0
      ? { count: baseVehicles.length, text: cur0s(lossTotal, baseCurrency) }
      : null;
  const create = useCommand(createOverviewAsset);
  const editCommand = useCommand(updateAssetDetails);
  const removeCommand = useCommand(removeOverviewAsset);
  const restoreCommand = useCommand(restoreOverviewAsset);
  const [selected, setSelected] = useState<string | null>(null);
  const [newType, setNewType] = useState<string | null>(null);
  const [form, setForm] = useState<Form>({
    name: "",
    type: "property",
    value: "",
    currency: "PLN",
    onDate: today,
    note: "",
    purchasePrice: "",
    purchaseDate: today,
    annualRate: "15",
    floor: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [undone, setUndone] = useState<string | null>(null);
  const target = selected === null ? null : (rows.find((row) => row.gid === selected) ?? null);
  const live =
    target?.kind === "vehicle" || (target === null && form.type === "vehicle")
      ? curvePreview(
          {
            price: form.purchasePrice,
            purchaseDate: form.purchaseDate,
            ratePct: form.annualRate,
            floor: form.floor,
          },
          today,
        )
      : null;
  const preview =
    live === null
      ? null
      : A.todayApprox(
          cur0s(live.value, target?.currency ?? form.currency),
          cur0s(live.loss, target?.currency ?? form.currency),
        );
  const open = newType !== null || target !== null;
  const openNew = (type: string, currency: string) => {
    setSelected(null);
    setNewType(type);
    setForm({
      name: "",
      type,
      value: "",
      currency,
      onDate: today,
      note: "",
      purchasePrice: "",
      purchaseDate: today,
      annualRate: "15",
      floor: "",
    });
    setError(null);
  };
  const openEdit = (gid: string) => {
    const row = rows.find((entry) => entry.gid === gid);
    if (!row) return;
    setNewType(null);
    setSelected(gid);
    setForm({
      name: row.name,
      type: row.type,
      value: row.amount?.format("f") ?? "",
      currency: row.currency,
      onDate: row.asOf ?? today,
      note: row.note ?? "",
      purchasePrice: row.depreciation?.purchasePrice.format("f") ?? "",
      purchaseDate: row.depreciation?.purchaseDate ?? today,
      annualRate: row.depreciation?.annualRate.format("f") ?? "15",
      floor: row.depreciation?.floor?.format("f") ?? "",
    });
    setError(null);
  };
  const close = () => {
    setSelected(null);
    setNewType(null);
    setError(null);
  };
  const set = (key: keyof Form, value: string) => setForm((prior) => ({ ...prior, [key]: value }));
  const submit = async () => {
    const isVehicle = target?.kind === "vehicle" || (target === null && form.type === "vehicle");
    const amount = decimal(form.value);
    const purchasePrice = decimal(form.purchasePrice, false);
    const annualRate = decimal(form.annualRate);
    const floor = form.floor.trim() === "" ? null : decimal(form.floor);
    const type = assetType(form.type);
    if (
      form.name.trim() === "" ||
      type === null ||
      (isVehicle &&
        (purchasePrice === null ||
          annualRate === null ||
          (floor === null && form.floor.trim() !== ""))) ||
      (!isVehicle && amount === null)
    ) {
      setError(W.invalidAsset);
      return;
    }
    setError(null);
    try {
      if (target === null && newType !== null) {
        const result = await create.run({
          name: form.name,
          type,
          currency: form.currency,
          note: form.note,
          ...(isVehicle
            ? {
                curve: {
                  purchasePrice: purchasePrice as string,
                  purchaseDate: form.purchaseDate,
                  annualRate: annualRate as string,
                  floor,
                },
              }
            : { value: amount as string, onDate: form.onDate }),
        });
        if (!result.ok) {
          setError(W.assetRefused);
          return;
        }
      } else if (target !== null) {
        if (target.kind === "vehicle") {
          if (
            purchasePrice === null ||
            annualRate === null ||
            !(
              await editCommand.run({
                account: target.gid,
                depreciation: { purchasePrice, purchaseDate: form.purchaseDate, annualRate, floor },
                ...(form.note !== (target.note ?? "") ? { note: form.note } : {}),
              })
            ).ok
          ) {
            setError(W.assetRefused);
            return;
          }
        } else {
          const valueChanged =
            amount !== null &&
            (target.amount === null || !target.amount.eq(D(amount)) || target.asOf !== form.onDate);
          const noteChanged = form.note !== (target.note ?? "");
          if (
            (valueChanged || noteChanged) &&
            !(
              await editCommand.run({
                account: target.gid,
                ...(valueChanged ? { value: amount as string, onDate: form.onDate } : {}),
                ...(noteChanged ? { note: form.note } : {}),
              })
            ).ok
          ) {
            setError(W.assetRefused);
            return;
          }
        }
      } else {
        setError(W.assetRefused);
        return;
      }
      close();
    } catch {
      setError(W.assetRefused);
    }
  };
  const remove = async () => {
    if (target === null || !rows.some((row) => row.gid === target.gid)) return;
    try {
      const result = await removeCommand.run({ account: target.gid });
      if (!result.ok) {
        setError(W.assetRefused);
        return;
      }
      setUndone(target.gid);
      close();
    } catch {
      setError(W.assetRefused);
    }
  };
  const undo = async () => {
    if (undone === null) return;
    try {
      if ((await restoreCommand.run({ account: undone })).ok) setUndone(null);
      else setError(W.assetRefused);
    } catch {
      setError(W.assetRefused);
    }
  };
  return {
    rows,
    displayRows,
    orderedTotals,
    lossSummary,
    preview,
    positionTypes,
    vehicleLabel: TYPE_LABEL.vehicle,
    target,
    open,
    form,
    error,
    undone,
    busy:
      create.isPending ||
      editCommand.isPending ||
      removeCommand.isPending ||
      restoreCommand.isPending,
    openNew,
    openEdit,
    close,
    set,
    submit,
    remove,
    undo,
  };
}

export type AssetDrawerState = ReturnType<typeof useAssetDrawer>;
