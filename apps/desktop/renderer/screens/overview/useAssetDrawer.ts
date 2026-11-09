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
import {
  curvePreview,
  dmy,
  monthlyLoss,
  ratePct,
  valuationLabel,
} from "@cashu/ui-logic/assets/logic";
import { cur0s, round0, TYPE_LABEL } from "@cashu/ui-logic/core/format";
import { isIncognito } from "@cashu/ui-logic/core/incognito";
import { useState } from "react";
import { assetStepsModel } from "../assets/assetStepsModel.js";
import { O } from "../CommandOutcome.strings.js";
import { commandFailure, useDurableCommands } from "../useDurableCommand.js";
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
  const durable = useDurableCommands();
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
  // An edit opened in incognito leaves the owner's money out of the form: its money fields start empty, and
  // an empty one saves as "unchanged" (the note and the date still save).
  const [masked, setMasked] = useState(false);
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
  const protectDraft = () => {
    if (
      durable.uncertain("asset-create") ||
      (target !== null &&
        (durable.uncertain(`asset-edit:${target.gid}`) ||
          durable.uncertain(`asset-remove:${target.gid}`)))
    ) {
      setError(O.unknown);
      return true;
    }
    return false;
  };
  const openNew = (type: string, currency: string) => {
    if (protectDraft()) return;
    setSelected(null);
    setNewType(type);
    setMasked(false);
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
    if (protectDraft()) return;
    const row = rows.find((entry) => entry.gid === gid);
    if (!row) return;
    setNewType(null);
    setSelected(gid);
    const hide = isIncognito();
    setMasked(hide);
    setForm({
      name: row.name,
      type: row.type,
      value: hide ? "" : (row.amount?.format("f") ?? ""),
      currency: row.currency,
      onDate: row.asOf ?? today,
      note: row.note ?? "",
      purchasePrice: hide ? "" : (row.depreciation?.purchasePrice.format("f") ?? ""),
      purchaseDate: row.depreciation?.purchaseDate ?? today,
      annualRate: row.depreciation?.annualRate.format("f") ?? "15",
      floor: hide ? "" : (row.depreciation?.floor?.format("f") ?? ""),
    });
    setError(null);
  };
  const close = () => {
    if (protectDraft()) return;
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
    // A masked edit (incognito) keeps the value or the curve the owner did not type again.
    const keepValue = masked && target !== null && form.value.trim() === "";
    const keepCurve = masked && target !== null && form.purchasePrice.trim() === "";
    if (
      form.name.trim() === "" ||
      type === null ||
      (isVehicle &&
        !keepCurve &&
        (purchasePrice === null ||
          annualRate === null ||
          (floor === null && form.floor.trim() !== ""))) ||
      (!isVehicle && amount === null && !keepValue)
    ) {
      setError(W.invalidAsset);
      return;
    }
    setError(null);
    try {
      if (target === null && newType !== null) {
        const result = await durable.run("asset-create", create, {
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
        if (result.kind !== "completed") {
          setError(commandFailure(result, W.assetRefused));
          return;
        }
      } else if (target !== null) {
        if (target.kind === "vehicle" && keepCurve) {
          if (form.note !== (target.note ?? "")) {
            const result = await durable.run(`asset-edit:${target.gid}`, editCommand, {
              account: target.gid,
              note: form.note,
            });
            if (result.kind !== "completed") {
              setError(commandFailure(result, W.assetRefused));
              return;
            }
          }
        } else if (target.kind === "vehicle") {
          if (purchasePrice === null || annualRate === null) {
            setError(W.assetRefused);
            return;
          }
          const result = await durable.run(`asset-edit:${target.gid}`, editCommand, {
            account: target.gid,
            depreciation: {
              purchasePrice,
              purchaseDate: form.purchaseDate,
              annualRate,
              // Opened in incognito the floor field starts empty: empty keeps the stored floor.
              floor:
                masked && form.floor.trim() === ""
                  ? (target.depreciation?.floor?.format("f") ?? null)
                  : floor,
            },
            ...(form.note !== (target.note ?? "") ? { note: form.note } : {}),
          });
          if (result.kind !== "completed") {
            setError(commandFailure(result, W.assetRefused));
            return;
          }
        } else {
          const valueChanged =
            amount !== null &&
            (target.amount === null || !target.amount.eq(D(amount)) || target.asOf !== form.onDate);
          const noteChanged = form.note !== (target.note ?? "");
          if (valueChanged || noteChanged) {
            const result = await durable.run(`asset-edit:${target.gid}`, editCommand, {
              account: target.gid,
              ...(valueChanged ? { value: amount as string, onDate: form.onDate } : {}),
              ...(noteChanged ? { note: form.note } : {}),
            });
            if (result.kind !== "completed") {
              setError(commandFailure(result, W.assetRefused));
              return;
            }
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
      const result = await durable.run(`asset-remove:${target.gid}`, removeCommand, {
        account: target.gid,
      });
      if (result.kind !== "completed") {
        setError(commandFailure(result, W.assetRefused));
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
      const result = await durable.run(`asset-restore:${undone}`, restoreCommand, {
        account: undone,
      });
      if (result.kind === "completed") setUndone(null);
      else setError(commandFailure(result, W.assetRefused));
    } catch {
      setError(W.assetRefused);
    }
  };
  // Display strings of the Majątek widget and the drawer (old AssetsWidget.tsx), formatted here so the Views
  // stay pure; the old formatters mask the digits in privacy mode.
  const totalsText = orderedTotals.map(([c, v]) => cur0s(v.toFloat(), c)).join(" · ");
  const widgetRows = displayRows.map((row) => ({
    gid: row.gid,
    name: row.name,
    note: row.note,
    value: cur0s(row.amount?.toFloat(), row.currency),
    sub: row.valuation,
    lossLine: row.lossLine,
  }));
  const drawerText =
    target === null
      ? { title: A.newPosition, tag: null, readOnlyValue: null, lastValuation: null }
      : {
          title: target.name,
          tag: TYPE_LABEL[target.type] ?? target.type,
          readOnlyValue: cur0s(target.amount?.toFloat(), target.currency),
          lastValuation: target.asOf ? A.lastValuation(dmy(target.asOf)) : null,
        };
  return {
    rows,
    displayRows,
    widgetRows,
    totalsText,
    /** The first steps' statuses and figures (old Steps.tsx), shared by the widget and the Majątek page. */
    steps: assetStepsModel(rows, totalsText),
    drawerText,
    orderedTotals,
    lossSummary,
    preview,
    positionTypes,
    vehicleLabel: TYPE_LABEL.vehicle,
    target,
    open,
    form,
    /** An edit opened in incognito: the money fields start empty (shown as dots) and empty keeps the value. */
    masked,
    error,
    undone,
    /** The drawer's save is running (also when started with Enter in the form). */
    saving: create.isPending || editCommand.isPending,
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
