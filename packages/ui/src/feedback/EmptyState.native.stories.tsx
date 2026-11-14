import { Text } from "react-native";
import type { Meta, Story } from "../charts/testing/csf.js";
import { EmptyState, type EmptyStateProps } from "./EmptyState.js";

const meta = {
  title: "Native/EmptyState",
  component: EmptyState,
  args: { icon: "search", title: "No transactions", body: "Nothing matches this search." },
} satisfies Meta<EmptyStateProps>;
export default meta;
export const Default: Story<EmptyStateProps> = {};
export const TitleOnly: Story<EmptyStateProps> = { args: { icon: undefined, body: undefined } };
export const WithAction: Story<EmptyStateProps> = {
  args: {
    icon: "sync",
    title: "Nothing synced yet",
    body: "Open cashU on your Mac to send the first copy.",
    action: <Text className="text-body text-accent">How it works</Text>,
  },
};
