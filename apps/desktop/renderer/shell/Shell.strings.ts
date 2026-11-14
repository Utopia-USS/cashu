// Texts of the desktop shell's header and tab bar that the Python app had (ab24ab6 core/chrome.strings.ts:
// ProfileMenu, IncognitoToggle, Shell). See docs/agents/localization.md.
import { catalog } from "@cashu/i18n";

export const S = catalog({
  brand: { pl: "cashU", en: "cashU" },
  profiles: { pl: "Profile", en: "Profiles" },
  newProfile: { pl: "Nowy profil…", en: "New profile…" },
  notConfiguredTitle: { pl: "Nieskonfigurowany", en: "Not set up" },
  // The incognito toggle's tooltip: amounts go on a banana scale, 🍌 1000 = the anchor
  // (`@cashu/domain` core/bananas.ts).
  bananasOff: {
    pl: "Ukryj kwoty: pokaż je w bananach. 🍌 1000 to średnia miesięczna pensja z ostatnich 12 miesięcy, a bez niej 10% portfela inwestycyjnego",
    en: "Hide amounts: show them in bananas. 🍌 1000 is your average monthly salary over the last 12 months, or 10% of your investment portfolio without one",
  },
  bananasSalary: {
    pl: "Kwoty w bananach: 🍌 1000 to Twoja średnia miesięczna pensja z ostatnich 12 miesięcy. Ceny walorów i liczba jednostek pozostają ukryte. Kliknij, aby pokazać kwoty",
    en: "Amounts in bananas: 🍌 1000 is your average monthly salary over the last 12 months. Prices and unit counts stay hidden. Click to show amounts",
  },
  bananasPortfolio: {
    pl: "Kwoty w bananach: 🍌 1000 to 10% Twojego portfela inwestycyjnego (budżet nie zna pensji). Ceny walorów i liczba jednostek pozostają ukryte. Kliknij, aby pokazać kwoty",
    en: "Amounts in bananas: 🍌 1000 is 10% of your investment portfolio (the budget knows no salary). Prices and unit counts stay hidden. Click to show amounts",
  },
  bananasMasked: {
    pl: "Kwoty ukryte: bananów nie ma do czego odnieść (brak pensji w budżecie i portfela inwestycyjnego). Kliknij, aby pokazać kwoty",
    en: "Amounts hidden: there is nothing to scale the bananas to (no salary in the budget and no investment portfolio). Click to show amounts",
  },
});
