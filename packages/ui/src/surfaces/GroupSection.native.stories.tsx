import { Text } from "react-native";
import type { Meta, Story } from "../charts/testing/csf.js";
import { ListRow } from "../lists/ListRow.js";
import { GroupSection, type GroupSectionProps } from "./GroupSection.js";

const rows = (
  <>
    <ListRow first name="Account" value="Synthetic current account" />
    <ListRow name="Date" value="12 November" />
  </>
);

const meta = {
  title: "Native/GroupSection",
  component: GroupSection,
  args: { title: "Details", children: rows },
} satisfies Meta<GroupSectionProps>;
export default meta;
export const Default: Story<GroupSectionProps> = {};
export const Untitled: Story<GroupSectionProps> = { args: { title: undefined } };
export const WithMeta: Story<GroupSectionProps> = {
  args: { title: "Category", meta: "Suggested: Groceries" },
};
export const Ungrouped: Story<GroupSectionProps> = {
  args: {
    title: "What your strategy says",
    grouped: false,
    children: <Text className="text-body text-fg-secondary">Hold through a 20% fall.</Text>,
  },
};
