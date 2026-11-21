import { pickLabel, type UiLang } from "../../../core/i18n.js";

export const evaluationReason = {
  divisionByZero: (lang: UiLang, column: number): string =>
    pickLabel(
      lang,
      `Dzielenie przez zero (kolumna ${column})`,
      `Division by zero (column ${column})`,
    ),
  overflow: (lang: UiLang, column: number): string =>
    pickLabel(
      lang,
      `Przepełnienie arytmetyczne (kolumna ${column})`,
      `Arithmetic overflow (column ${column})`,
    ),
  invalid: (lang: UiLang, column: number): string =>
    pickLabel(
      lang,
      `Nieprawidłowe działanie (kolumna ${column})`,
      `Invalid operation (column ${column})`,
    ),
};
