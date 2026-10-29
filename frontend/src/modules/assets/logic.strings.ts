// Texts of the assets module's pure helpers (logic.ts). See src/i18n.ts.
import { catalog } from "../../i18n.ts";

export const S = catalog({
  valuation: { pl: (date: string) => `wycena ${date}`, en: (date: string) => `valued ${date}` },
  future: { pl: "Data wyceny nie może być z przyszłości.", en: "The valuation date can't be in the future." },
  price: { pl: "Podaj cenę zakupu (liczba większa od 0).", en: "Enter the purchase price (a number greater than 0)." },
  purchaseDate: { pl: "Podaj datę zakupu.", en: "Enter the purchase date." },
  purchaseFuture: { pl: "Data zakupu nie może być z przyszłości.", en: "The purchase date can't be in the future." },
  rate: { pl: "Roczny spadek od 0 do 100 %.", en: "Yearly decline from 0 to 100%." },
  floorInvalid: { pl: "Wartość minimalna: liczba, 0 lub więcej.", en: "Minimum value: a number, 0 or more." },
  floorAbovePrice: { pl: "Wartość minimalna nie może przekraczać ceny zakupu.", en: "The minimum value can't exceed the purchase price." },
  name: { pl: "Podaj nazwę.", en: "Enter a name." },
  noteMax: { pl: (max: number) => `Notatka: maks. ${max} znaków.`, en: (max: number) => `Note: at most ${max} characters.` },
  value: { pl: "Podaj wartość (liczba, 0 lub więcej).", en: "Enter the value (a number, 0 or more)." },
});
