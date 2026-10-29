// Texts of the alert form checks (src/modules/investments/v2/alertForm.ts). See src/i18n.ts.
import { catalog } from "../../../i18n.ts";

export const S = catalog({
  pickInstrument: { pl: "Wybierz instrument z listy.", en: "Pick an instrument from the list." },
  pickBucket: { pl: "Wybierz koszyk.", en: "Pick a bucket." },
  priceLevel: { pl: "Podaj poziom ceny większy od zera.", en: "Enter a price level above zero." },
  window: { pl: (min: number) => `Okno: liczba sesji od ${min} do 260.`, en: (min: number) => `Window: ${min} to 260 sessions.` },
  changeThreshold: { pl: "Podaj próg zmiany w procentach.", en: "Enter the change threshold in percent." },
  drawdownThreshold: { pl: "Próg spadku: od 0 do 100 %.", en: "Drop threshold: 0 to 100%." },
  weightThreshold: { pl: "Próg wagi: od 0 do 100 % portfela.", en: "Weight threshold: 0 to 100% of the portfolio." },
  expression: { pl: "Wpisz wyrażenie.", en: "Enter an expression." },
  maxRange: { pl: "Zakres maks.: od 1 do 30 %.", en: "Max range: 1 to 30%." },
  multiple: { pl: "Krotność: od 1,5 do 20.", en: "Multiple: 1.5 to 20." },
});
