import type { Meta, Story } from "../charts/testing/csf.js";
import { Select } from "./Select.js";
import type { SelectProps } from "./Select.types.js";

const meta = {
  title: "Controls/Select",
  component: Select,
  args: {
    value: "PLN",
    onChange: () => {},
    label: "Currency",
    options: [
      { value: "PLN", label: "PLN" },
      { value: "EUR", label: "EUR" },
      { value: "USD", label: "USD" },
    ],
  },
} satisfies Meta<SelectProps>;
export default meta;
export const Default: Story<SelectProps> = {};
export const WithPlaceholder: Story<SelectProps> = {
  args: {
    value: "",
    options: [
      { value: "", label: "Choose an account" },
      { value: "a", label: "Everyday account" },
    ],
  },
};
export const DisabledOption: Story<SelectProps> = {
  args: {
    options: [
      { value: "PLN", label: "PLN" },
      { value: "CHF", label: "CHF", disabled: true },
    ],
  },
};
export const Disabled: Story<SelectProps> = { args: { disabled: true } };
export const LabelHidden: Story<SelectProps> = { args: { labelHidden: true } };
export const Inline: Story<SelectProps> = { args: { inline: true } };
export const FullWidth: Story<SelectProps> = { args: { className: "w-full" } };
