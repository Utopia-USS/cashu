import { Pressable, Text, View } from "react-native";
import { Icon } from "../icons/Icon.js";

export type KeypadKey =
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "."
  | "backspace";

export interface KeypadProps {
  onKey(key: KeypadKey): void;
  /** The decimal key's face in the owner's locale ("," in Polish); the key itself is always ".". */
  decimalLabel?: string;
  /** Translated accessible name of the backspace key ("Delete"). */
  backspaceLabel: string;
}

const ROWS: readonly (readonly KeypadKey[])[] = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  [".", "0", "backspace"],
];

/**
 * The amount typed so far after one key (prototype cash keypad): backspace drops the last character;
 * "." only once ("0." when empty, refused when `maxFraction` is 0); digits past `maxFraction` decimals are
 * refused; a lone "0" is replaced by the next digit, so leading zeros never accumulate.
 */
export function applyKeypadKey(current: string, key: KeypadKey, maxFraction = 2): string {
  if (key === "backspace") return current.slice(0, -1);
  const dot = current.indexOf(".");
  if (key === ".") {
    if (dot >= 0 || maxFraction <= 0) return current;
    return current === "" ? "0." : `${current}.`;
  }
  if (dot >= 0) return current.length - dot - 1 >= maxFraction ? current : current + key;
  return current === "0" ? key : current + key;
}

/** Numeric 3 x 4 keypad for amounts typed on the phone (cash expense). */
export function Keypad({ onKey, decimalLabel = ".", backspaceLabel }: KeypadProps) {
  return (
    <View className="gap-2">
      {ROWS.map((row) => (
        <View key={row.join("")} className="flex-row gap-2">
          {row.map((key) => (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={
                key === "backspace" ? backspaceLabel : key === "." ? decimalLabel : key
              }
              onPress={() => onKey(key)}
              className="h-14 flex-1 items-center justify-center rounded-lg bg-subtle active:bg-chip"
            >
              {key === "backspace" ? (
                <Icon name="backspace" size={24} className="text-fg" />
              ) : (
                <Text className="text-title text-fg">{key === "." ? decimalLabel : key}</Text>
              )}
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}
