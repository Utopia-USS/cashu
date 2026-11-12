// Jest boundary for the platform-native @expo/ui binding in the packages/ui native tests: a copy of
// apps/mobile/src/screens/testing/expoUiMock.tsx (packages may not import an app) plus `Switch`. The
// components under test and their callbacks stay real; only the SwiftUI / Compose views are stood in.
import { Children, isValidElement, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

function Container({ children, testID }: { children?: ReactNode; testID?: string }) {
  return <View testID={testID}>{children}</View>;
}

const Host = Container;
const Column = Container;
const Row = Container;

interface ItemProps {
  label: string;
  value: string | number;
}
interface PickerProps {
  selectedValue: string | number;
  onValueChange(value: string | number): void;
  enabled?: boolean;
  children?: ReactNode;
  testID?: string;
}

function MockPicker({ selectedValue, onValueChange, enabled, children, testID }: PickerProps) {
  const selected = Children.toArray(children).find(
    (child) => isValidElement<ItemProps>(child) && child.props.value === selectedValue,
  );
  return (
    <View
      testID={testID}
      accessibilityState={{ disabled: enabled === false }}
      {...{ selectedValue, onValueChange }}
    >
      <Text>{isValidElement<ItemProps>(selected) ? selected.props.label : ""}</Text>
    </View>
  );
}
const Picker = Object.assign(MockPicker, { Item: (_props: ItemProps) => null });

function Button({
  label,
  children,
  onPress,
  disabled,
  testID,
}: {
  label?: string;
  children?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled === true }}
    >
      {children ?? <Text>{label}</Text>}
    </Pressable>
  );
}

/** The native toggle: `fireEvent(node, "valueChange", next)` drives `onValueChange`. */
function Switch({
  value,
  onValueChange,
  disabled,
  testID = "expo-ui-switch",
}: {
  value: boolean;
  onValueChange(value: boolean): void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      accessibilityState={{ checked: value, disabled: disabled === true }}
      {...{ value, onValueChange }}
    />
  );
}

export default { Host, Column, Row, Picker, Button, Switch };
