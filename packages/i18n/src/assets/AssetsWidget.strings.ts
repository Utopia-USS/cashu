// Texts of the assets widget and its drawer (AssetsWidget.tsx). See docs/agents/localization.md.
import { catalog, enForm, plForm } from "../index.js";

export const S = catalog({
  title: { pl: "Majątek", en: "Assets" },
  curve: { pl: "krzywa utraty wartości", en: "depreciation curve" },
  perYear: { pl: (rate: string) => ` · ${rate} % / rok`, en: (rate: string) => ` · ${rate}% / yr` },
  staleTitle: { pl: "wycena starsza niż rok", en: "valuation older than a year" },
  lossPerMonth: {
    pl: (amount: string) => `-${amount} / mies.`,
    en: (amount: string) => `-${amount} / mo`,
  },
  floorReached: { pl: "wartość minimalna", en: "minimum value" },
  setupLink: { pl: "Instrukcja Claude Code i CLI", en: "Claude Code and CLI instructions" },
  addPlus: { pl: "+ Dodaj", en: "+ Add" },
  total: { pl: "razem", en: "total" },
  cars: {
    pl: (n: number) => plForm(n, "auto", "auta", "auta"),
    en: (n: number) => enForm(n, "car", "cars"),
  },
  perMonth: { pl: " / mies.", en: " / mo" },
  less: { pl: "mniej", en: "less" },
  all: { pl: (n: number) => `wszystkie (${n})`, en: (n: number) => `all (${n})` },
  editOf: { pl: (name: string) => `Edytuj: ${name}`, en: (name: string) => `Edit: ${name}` },
  note: { pl: "notatka", en: "note" },
  value: { pl: "Wartość", en: "Value" },
  valuationDate: { pl: "Data wyceny", en: "Valuation date" },
  purchasePrice: { pl: "Cena zakupu", en: "Purchase price" },
  currency: { pl: "Waluta", en: "Currency" },
  purchaseDate: { pl: "Data zakupu", en: "Purchase date" },
  yearlyDecline: { pl: "Roczny spadek (%)", en: "Yearly decline (%)" },
  floor: { pl: "Wartość minimalna (opcjonalnie)", en: "Minimum value (optional)" },
  todayApprox: {
    pl: (value: string, loss: string) => `dziś ≈ ${value} · -${loss} / mies.`,
    en: (value: string, loss: string) => `today ≈ ${value} · -${loss} / mo`,
  },
  noteLabel: { pl: "Notatka", en: "Note" },
  newPosition: { pl: "Nowa pozycja", en: "New position" },
  saving: { pl: "Zapisuję…", en: "Saving…" },
  name: { pl: "Nazwa", en: "Name" },
  type: { pl: "Typ", en: "Type" },
  lastValuation: {
    pl: (date: string) => `ostatnia wycena ${date}`,
    en: (date: string) => `last valued ${date}`,
  },
});
