import { View } from "react-native";
import type { Decorator, Meta, Story } from "../charts/testing/csf.js";
import { Icon } from "../icons/Icon.js";
import { Button } from "./Button.js";
import type { ButtonProps } from "./Button.types.js";

const meta = {
  title: "Native/Button",
  component: Button,
  args: { children: "Plan PLN 1,000", onPress: () => {} },
} satisfies Meta<ButtonProps>;
export default meta;

/** A phone-width column, so `block` has a width to fill. */
const column: Decorator = (Story) => (
  <View className="w-full gap-2 p-4">
    <Story />
  </View>
);

export const Primary: Story<ButtonProps> = { args: { variant: "primary" } };
export const Secondary: Story<ButtonProps> = { args: { children: "Other amount" } };
export const Danger: Story<ButtonProps> = { args: { variant: "danger", children: "Remove" } };
export const Ghost: Story<ButtonProps> = { args: { variant: "ghost", children: "Skip" } };
export const Link: Story<ButtonProps> = {
  args: { variant: "link", children: "Show the running month" },
};
export const Small: Story<ButtonProps> = {
  args: { variant: "primary", size: "sm", children: "Use it" },
};
export const Medium: Story<ButtonProps> = { args: { size: "md" } };
export const Large: Story<ButtonProps> = { args: { variant: "primary", size: "lg" } };
export const Block: Story<ButtonProps> = {
  args: { variant: "primary", block: true, children: "Add PLN 45.90" },
  decorators: [column],
};
export const BlockSecondary: Story<ButtonProps> = {
  args: { block: true, children: "Other amount" },
  decorators: [column],
};
export const Pending: Story<ButtonProps> = {
  args: { variant: "primary", block: true, pending: true },
  decorators: [column],
};
export const Disabled: Story<ButtonProps> = { args: { variant: "primary", disabled: true } };
export const Pressed: Story<ButtonProps> = { args: { pressed: true, children: "Month" } };
export const IconPlus: Story<ButtonProps> = {
  args: { variant: "icon", label: "Add a cash expense", children: <Icon name="plus" size={20} /> },
};
export const IconClose: Story<ButtonProps> = {
  args: { variant: "icon", label: "Close", children: <Icon name="x" size={20} /> },
};
export const Glyph: Story<ButtonProps> = {
  args: { variant: "glyph", label: "More", children: <Icon name="more" size={20} /> },
};
