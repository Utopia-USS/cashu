import { View } from "react-native";
import type { Decorator, Meta, Story } from "../charts/testing/csf.js";
import { ICON_NAMES, Icon, type IconProps } from "./Icon.js";

const meta = {
  title: "Native/Icon",
  component: Icon,
  args: { name: "eye" },
} satisfies Meta<IconProps>;
export default meta;

/** Every icon at every size, under the story's own icon. */
const grid: Decorator = (Story) => (
  <View className="gap-3">
    <Story />
    {([16, 20, 24] as const).map((size) => (
      <View key={size} className="flex-row flex-wrap gap-3">
        {ICON_NAMES.map((name) => (
          <Icon key={name} name={name} size={size} />
        ))}
      </View>
    ))}
  </View>
);

export const Default: Story<IconProps> = {};
export const Muted: Story<IconProps> = { args: { name: "doc", className: "text-fg-muted" } };
export const Grid: Story<IconProps> = {
  args: { name: "sparkle", size: 24, className: "text-accent" },
  decorators: [grid],
};
