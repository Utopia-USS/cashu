// The phone's instrument tile (design/mobile/companion prototype `.tk`, the ticker square of a position
// row): a black square with the ticker in light type, in both themes, and an optional ring that says the
// position needs a look (`negative`: an open risk signal). A phone-only component: the desktop's
// `InstTile` (InstTile.tsx) draws plan coins, strength glyphs and thesis-health rings on DOM, and a
// `.native.tsx` twin of it would have to carry InstLabel and PlanGlyph too.
import { Text, View } from "react-native";

export interface TickerTileProps {
  /** The ticker monogram; 5 characters or more step the type down. */
  ticker: string;
  /** `row` (a list row, 40 x 28 pt) or `header` (a page header, 52 x 34 pt). */
  size?: "row" | "header";
  /** A ring around the tile: `negative` = an open risk signal, `warning` = worth a look. */
  ring?: "negative" | "warning" | null;
}

const boxes = {
  row: { box: "h-7 w-10 rounded-sm", type: "text-3xs-plus", dense: "text-4xs" },
  header: { box: "h-8.5 w-13 rounded-sm-plus", type: "text-sm", dense: "text-2xs-plus" },
} as const;
const rings = { negative: "border-2 border-negative", warning: "border-2 border-warning" } as const;

/** Decorative: the row beside it names the instrument. */
export function TickerTile({ ticker, size = "row", ring = null }: TickerTileProps) {
  const look = boxes[size];
  const dense = ticker.length >= 5;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={`shrink-0 items-center justify-center overflow-hidden bg-av-bg px-0.5 ${look.box} ${ring === null ? "" : rings[ring]}`}
    >
      <Text
        numberOfLines={1}
        className={`font-heavy text-av-fg tabular-nums ${dense ? `${look.dense} tracking-dense` : `${look.type} tracking-snug`}`}
      >
        {ticker}
      </Text>
    </View>
  );
}
