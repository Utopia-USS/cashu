import { Text } from "react-native";
import { type ValueTextProps, valueClasses } from "./presentation.js";

/** The native text leaf; Dynamic Type stays enabled. */
export function ValueText(props: ValueTextProps) {
  return (
    <Text className={valueClasses(props)} accessibilityLabel={props.accessibleText}>
      {props.text}
    </Text>
  );
}
