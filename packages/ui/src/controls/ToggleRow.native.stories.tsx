import type { Meta, Story } from "../charts/testing/csf.js";
import { ToggleRow, type ToggleRowProps } from "./ToggleRow.js";

const meta = {
  title: "Native/ToggleRow",
  component: ToggleRow,
  args: { label: "Hide amounts", value: false, onChange: () => {} },
} satisfies Meta<ToggleRowProps>;
export default meta;
export const Off: Story<ToggleRowProps> = {};
export const On: Story<ToggleRowProps> = { args: { value: true } };
export const WithSub: Story<ToggleRowProps> = {
  args: {
    label: "Same for every payment to this payee",
    sub: "Future ones too; older ones update on the Mac",
  },
};
export const Fixed: Story<ToggleRowProps> = {
  args: { label: "Weekly review reminder", value: false, fixed: true },
};
export const Disabled: Story<ToggleRowProps> = {
  args: {
    label: "Same for every payment to this payee",
    sub: "Pick a category first",
    value: false,
    disabled: true,
  },
};
