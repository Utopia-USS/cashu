// Texts of the subscriptions tab (Subscriptions.tsx). See src/i18n.ts.
import { catalog } from "../../i18n.ts";

export const S = catalog({
  title: { pl: "Subskrypcje", en: "Subscriptions" },
  payee: { pl: "Odbiorca", en: "Payee" },
  amount: { pl: "Kwota", en: "Amount" },
  every: { pl: "Co", en: "Every" },
  last: { pl: "Ostatnio", en: "Last" },
  none: { pl: "Brak subskrypcji.", en: "No subscriptions." },
  active: { pl: "aktywna", en: "active" },
  /** The gap between payments in days ("30d"). */
  days: { pl: (n: number) => `${n}d`, en: (n: number) => `${n}d` },
});
