import type { Meta, Story } from "../charts/testing/csf.js";
import { TabBar, type TabBarProps } from "./TabBar.js";

const meta = {
  title: "Shell/TabBar",
  component: TabBar,
  args: {
    label: "Modules",
    groups: [
      [{ id: "overview", label: "Overview", current: false, onPress: () => {} }],
      [{ id: "budget", label: "Budget", current: false, pending: true, onPress: () => {} }],
      [{ id: "investments", label: "Investments", current: true, onPress: () => {} }],
    ],
  },
} satisfies Meta<TabBarProps>;
export default meta;
export const Default: Story<TabBarProps> = {};
