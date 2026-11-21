import { Text, TextInput, View } from "react-native";
import type { TextFieldProps } from "./TextField.types.js";

const keyboards = {
  text: "default",
  number: "decimal-pad",
  date: "numbers-and-punctuation",
  password: "default",
  url: "url",
  search: "web-search",
} as const;

/** Native labelled text entry with the same field look and states as the desktop control. */
export function TextField({
  value,
  onChange,
  onBlur,
  onFocus,
  label,
  labelHidden,
  inline,
  type = "text",
  multiline,
  rows,
  inputMode,
  placeholder,
  maxLength,
  disabled,
  invalid,
  testID,
  autoFocus,
  className = "",
}: TextFieldProps) {
  return (
    <View className={`${inline ? "flex-row items-center gap-2" : "gap-1"} ${className}`}>
      {!labelHidden && <Text className="text-body text-fg">{label}</Text>}
      <TextInput
        value={value}
        onChangeText={onChange}
        onBlur={onBlur}
        onFocus={onFocus}
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        aria-invalid={invalid}
        keyboardType={inputMode ? undefined : keyboards[type]}
        inputMode={inputMode}
        secureTextEntry={type === "password"}
        multiline={multiline}
        numberOfLines={rows}
        placeholder={placeholder}
        maxLength={maxLength}
        editable={!disabled}
        autoFocus={autoFocus}
        testID={testID}
        className={`rounded-sm border bg-surface px-3 py-2 text-body text-fg ${invalid ? "border-negative" : "border-border"} ${disabled ? "opacity-50" : ""}`}
      />
    </View>
  );
}
