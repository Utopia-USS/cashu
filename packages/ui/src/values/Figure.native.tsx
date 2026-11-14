// The phone's hero figure (visual.md "Money display", prototype `.hero-fig`): one big amount per screen, the
// currency small and muted at the top (before the digits in English, after them in Polish), the decimals
// muted, the whole part heavy and tight. Formatting and privacy come from useNumberValue, exactly as for
// `Money`; this file only splits the finished text into its parts.
import type { Money } from "@cashu/domain";
import { BANANA } from "@cashu/i18n/values";
import { Text, View } from "react-native";
import { useNumberValue } from "./useNumberValue.js";

export interface FigureProps {
  value: Money | null;
  /** `screen` (default): the screen's statement; `sheet`: the figure of a sheet; `card`: a card's one number. */
  size?: "screen" | "sheet" | "card";
  fractionDigits?: 0 | 2;
  /** `negative` only for a change or a loss shown as the figure; balances stay `default`. */
  tone?: "default" | "negative";
}

const looks = {
  screen: { figure: "text-statement-tile", unit: "mt-1 text-lg-plus font-strong" },
  sheet: { figure: "text-6xl", unit: "mt-1 text-base font-strong" },
  card: { figure: "text-display", unit: "mt-0.5 text-sm font-medium" },
} as const;

/** A formatted amount split for the figure; joined, sign + pre + main + fraction + post is the input. */
interface FigureParts {
  sign: string;
  pre: string;
  main: string;
  fraction: string;
  post: string;
}

const FIGURE = /^([+-]?)([^\d+-]*)([+-]?\d[\d\s.,]*?)([.,]\d{2})?(\s*\D*)$/u;

/** "PLN 1,234.50" -> "", "PLN ", "1,234", ".50", ""; "-61 789,61 zł" -> "-", "", "61 789", ",61", " zł".
 * Null when the text has no digits (the privacy mask, the dash of a missing value). */
function figureParts(text: string): FigureParts | null {
  const m = FIGURE.exec(text);
  if (!m) return null;
  return {
    sign: m[1] ?? "",
    pre: m[2] ?? "",
    main: m[3] ?? "",
    fraction: m[4] ?? "",
    post: m[5] ?? "",
  };
}

/** The hero amount; privacy shows it on the banana scale or masked, like every other amount. */
export function Figure({ value, size = "screen", fractionDigits, tone = "default" }: FigureProps) {
  const display = useNumberValue(value?.amount ?? null, {
    ...(value ? { currency: value.currency } : {}),
    ...(fractionDigits === undefined ? {} : { fractionDigits }),
  });
  const look = looks[size];
  const ink = !display.hidden && tone === "negative" ? "text-negative" : "text-fg";
  const big = `${look.figure} font-bold leading-none tracking-dense tabular-nums`;
  const parts = figureParts(display.text);
  // The banana is the unit of the privacy scale, not a currency: it stays with the digits at full size.
  const banana = parts !== null && (parts.pre.includes(BANANA) || parts.post.includes(BANANA));
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={display.accessibleText}
      className="flex-row items-start"
    >
      {parts === null || banana ? (
        <Text className={`${big} ${ink}`}>{display.text}</Text>
      ) : (
        <>
          {parts.pre.trim() !== "" && (
            <Text className={`mr-1.5 tracking-normal text-fg-muted ${look.unit}`}>
              {parts.pre.trim()}
            </Text>
          )}
          <Text className={`${big} ${ink}`}>{`${parts.sign}${parts.main}`}</Text>
          {parts.fraction !== "" && (
            <Text className={`${big} text-fg-muted`}>{parts.fraction}</Text>
          )}
          {parts.post.trim() !== "" && (
            <Text className={`ml-1.5 tracking-normal text-fg-muted ${look.unit}`}>
              {parts.post.trim()}
            </Text>
          )}
        </>
      )}
    </View>
  );
}
