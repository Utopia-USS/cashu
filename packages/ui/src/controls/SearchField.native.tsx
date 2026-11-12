import { Pressable, TextInput, View } from "react-native";
import { Icon } from "../icons/Icon.js";

export interface SearchFieldProps {
  value: string;
  /** Translated placeholder, also the accessible name of the field. */
  placeholder: string;
  onChange(value: string): void;
  onClear(): void;
  /** Translated accessible name of the clear button ("Clear search"). */
  clearLabel: string;
  autoFocus?: boolean;
}

// The 16 pt clear icon grows to the 44 pt minimum touch target without changing its look.
const HIT_SLOP = 14;

/**
 * Search box of the phone (prototype `.search`): a controlled React Native text input (@expo/ui's
 * TextInput is uncontrolled and has no clear button slot) on the subtle fill, a search icon before it and
 * a clear button while there is text.
 */
export function SearchField({
  value,
  placeholder,
  onChange,
  onClear,
  clearLabel,
  autoFocus,
}: SearchFieldProps) {
  return (
    <View className="min-h-11 py-2 flex-row items-center gap-2 rounded-lg bg-subtle px-3">
      <Icon name="search" className="text-fg-muted" />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        accessibilityLabel={placeholder}
        autoFocus={autoFocus}
        autoCorrect={false}
        returnKeyType="search"
        placeholderTextColorClassName="accent-fg-muted"
        cursorColorClassName="accent-accent"
        className="flex-1 text-body text-fg"
      />
      {value !== "" && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={clearLabel}
          hitSlop={HIT_SLOP}
          onPress={onClear}
          className="items-center justify-center"
        >
          <Icon name="x" className="text-fg-muted" />
        </Pressable>
      )}
    </View>
  );
}
