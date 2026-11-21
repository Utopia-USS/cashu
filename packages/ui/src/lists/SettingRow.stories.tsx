import type { Meta, Story } from "../charts/testing/csf.js";
import { SettingRow, type SettingRowProps } from "./SettingRow.js";

const meta = {
  title: "Lists/SettingRow",
  component: SettingRow,
  args: { title: "Budget", detail: "Accounts, spending and recurring payments" },
} satisfies Meta<SettingRowProps>;
export default meta;
export const Default: Story<SettingRowProps> = {};
