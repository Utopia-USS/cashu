// Texts of the assets first steps (Steps.tsx). See src/i18n.ts.
import { catalog, enCount, plCount } from "../../i18n.ts";

export const S = catalog({
  position: { pl: "Pozycja", en: "Position" },
  positionsDone: {
    pl: (n: number, totals: string) => `${plCount(n, "pozycja", "pozycje", "pozycji")} · razem ${totals}`,
    en: (n: number, totals: string) => `${enCount(n, "position", "positions")} · total ${totals}`,
  },
  positionHint: { pl: "Mieszkanie, działka, inne aktywa: nazwa, wartość, waluta.", en: "A flat, a plot, other assets: name, value, currency." },
  addAnother: { pl: "Dodaj kolejną", en: "Add another" },
  addPosition: { pl: "Dodaj pozycję", en: "Add a position" },
  vehicle: { pl: "Auto", en: "Car" },
  vehicleDone: {
    pl: (name: string, rate: string, loss: string) => `${name} · ${rate} % / rok · -${loss} / mies.`,
    en: (name: string, rate: string, loss: string) => `${name} · ${rate}% / yr · -${loss} / mo`,
  },
  vehicleHint: { pl: "Cena i data zakupu, roczny spadek; wartość liczy się sama.", en: "Purchase price and date, yearly decline; the value is computed for you." },
  addVehicle: { pl: "Dodaj auto", en: "Add a car" },
});
