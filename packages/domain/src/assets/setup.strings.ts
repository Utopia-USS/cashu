/**
 * UI texts of the assets' blank-page steps (`modules/assets/setup.py`), Polish and English, byte-equal to
 * the Python source (parity check `core.overview`). The placeholder names in the commands are UI text.
 */

export const assetsSetupStrings = {
  flat: { pl: "Mieszkanie", en: "Flat" },
  car: { pl: "Auto", en: "Car" },
  positionTitle: { pl: "Pozycja", en: "Position" },
  positionDescription: {
    pl: "Mieszkanie, działka, inne aktywa: nazwa, wartość, waluta.",
    en: "A flat, a plot, other assets: name, value, currency.",
  },
  vehicleDescription: {
    pl: "Cena i data zakupu, roczny spadek; wartość liczy się sama.",
    en: "Purchase price and date, yearly decline; the value is computed for you.",
  },
} as const;
