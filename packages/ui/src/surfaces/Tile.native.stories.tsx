import { Text } from "react-native";
import type { Meta, Story } from "../charts/testing/csf.js";
import { Tile, type TileProps } from "./Tile.js";

const body = <Text className="text-body text-fg">Rent, groceries and transport so far.</Text>;

const meta = {
  title: "Native/Tile",
  component: Tile,
  args: { title: "This month", meta: "Nov 1 - 12", children: body },
} satisfies Meta<TileProps>;
export default meta;
export const Default: Story<TileProps> = {};
export const Bare: Story<TileProps> = { args: { title: undefined, meta: undefined } };
export const Warning: Story<TileProps> = {
  args: { tone: "warning", title: "Bank access expires in 3 days", meta: undefined },
};
export const Pressable: Story<TileProps> = {
  args: { onPress: () => {}, accessibilityLabel: "Open this month" },
};
