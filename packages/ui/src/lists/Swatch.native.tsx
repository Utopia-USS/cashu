import { View } from "react-native";

/** The colour key of a category or a series on the phone: a token role, never a raw colour. */
export type SwatchColor =
  | "palette-1"
  | "palette-2"
  | "palette-3"
  | "palette-4"
  | "palette-5"
  | "palette-6"
  | "palette-7"
  | "palette-8"
  | "palette-9"
  | "palette-10"
  | "palette-11"
  | "palette-12"
  | "palette-13"
  | "palette-14"
  | "palette-15"
  | "palette-16"
  | "palette-17"
  | "palette-18"
  | "palette-19"
  | "palette-20"
  | "palette-21"
  | "palette-22"
  | "fg-muted"
  | "accent"
  | "warning"
  | "positive"
  | "negative";

// Literal class per role: Uniwind generates only the classes it finds written out in a source.
const BG: Record<SwatchColor, string> = {
  "palette-1": "bg-palette-1",
  "palette-2": "bg-palette-2",
  "palette-3": "bg-palette-3",
  "palette-4": "bg-palette-4",
  "palette-5": "bg-palette-5",
  "palette-6": "bg-palette-6",
  "palette-7": "bg-palette-7",
  "palette-8": "bg-palette-8",
  "palette-9": "bg-palette-9",
  "palette-10": "bg-palette-10",
  "palette-11": "bg-palette-11",
  "palette-12": "bg-palette-12",
  "palette-13": "bg-palette-13",
  "palette-14": "bg-palette-14",
  "palette-15": "bg-palette-15",
  "palette-16": "bg-palette-16",
  "palette-17": "bg-palette-17",
  "palette-18": "bg-palette-18",
  "palette-19": "bg-palette-19",
  "palette-20": "bg-palette-20",
  "palette-21": "bg-palette-21",
  "palette-22": "bg-palette-22",
  "fg-muted": "bg-fg-muted",
  accent: "bg-accent",
  warning: "bg-warning",
  positive: "bg-positive",
  negative: "bg-negative",
};

/** An 8 px colour square (decorative: the row or cell beside it carries the name). */
export function Swatch({ color }: { color: SwatchColor }) {
  return (
    <View
      className={`size-2 shrink-0 rounded-xs ${BG[color]}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}
