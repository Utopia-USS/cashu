import type { Meta, Story } from "../charts/testing/csf.js";
import { IconToggle, type IconToggleProps } from "./IconToggle.js";

const meta = {
  title: "Controls/IconToggle",
  component: IconToggle,
  args: { checked: false, onChange: () => {}, label: "Hide amounts", children: "o" },
} satisfies Meta<IconToggleProps>;
export default meta;
export const Off: Story<IconToggleProps> = {};
export const On: Story<IconToggleProps> = { args: { checked: true } };
