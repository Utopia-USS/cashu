// Copy shared by the screens that file a payment (the payment sheet and the categorize deck): the one
// control that pins a payee to a category. PL + EN. A payee is a brand name that Polish cannot inflect,
// so the Polish sentences put it after a colon.
import { catalog } from "@cashu/i18n";

export const S = catalog({
  ruleTitle: {
    pl: (payee: string) => `Tak samo dla każdej płatności: ${payee}`,
    en: (payee: string) => `Same for every ${payee} payment`,
  },
  rulePast: {
    pl: (n: number) => `Także wcześniejsze i przyszłe (dotąd ${n})`,
    en: (n: number) => `Also past and future ones (${n} so far)`,
  },
});
