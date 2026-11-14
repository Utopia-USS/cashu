import type { Meta, Story } from "../charts/testing/csf.js";
import { FreshLine, type FreshLineProps } from "./FreshLine.js";

const meta = {
  title: "Native/FreshLine",
  component: FreshLine,
  args: { tone: "ok", children: "Synced 2 h ago" },
} satisfies Meta<FreshLineProps>;
export default meta;
export const Ok: Story<FreshLineProps> = {};
export const Warn: Story<FreshLineProps> = {
  args: { tone: "warn", children: "Bank access expires in 3 days" },
};
export const Muted: Story<FreshLineProps> = { args: { tone: "muted", children: "Not connected" } };
