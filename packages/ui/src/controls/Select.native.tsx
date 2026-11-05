import { Host, Picker } from "@expo/ui";
import { Text, View } from "react-native";
import type { SelectProps } from "./Select.types.js";

/** Native labelled single-choice picker (platform menu) over the same options as the desktop control. */
export function Select({
  value,
  onChange,
  options,
  label,
  labelHidden,
  inline,
  disabled,
  testID,
  className = "",
}: SelectProps) {
  return (
    <View
      accessibilityLabel={label}
      className={`${inline ? "flex-row items-center gap-2" : "gap-1"} ${className}`}
    >
      {!labelHidden && <Text className="text-body text-fg">{label}</Text>}
      <Host matchContents>
        <Picker
          selectedValue={value}
          enabled={!disabled}
          testID={testID}
          onValueChange={(next) => {
            if (next !== value) onChange(next);
          }}
        >
          {options
            .filter((option) => !option.disabled || option.value === value)
            .map((option) => (
              <Picker.Item key={option.value} value={option.value} label={option.label} />
            ))}
        </Picker>
      </Host>
    </View>
  );
}
