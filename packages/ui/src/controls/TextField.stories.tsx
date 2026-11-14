import type { Meta, Story } from "../charts/testing/csf.js";
import { TextField } from "./TextField.js";
import type { TextFieldProps } from "./TextField.types.js";

const meta = {
  title: "Controls/TextField",
  component: TextField,
  args: { value: "Holiday fund", onChange: () => {}, label: "Name" },
} satisfies Meta<TextFieldProps>;
export default meta;
export const Default: Story<TextFieldProps> = {};
export const Empty: Story<TextFieldProps> = {
  args: { value: "", placeholder: "e.g. Holiday fund" },
};
export const Amount: Story<TextFieldProps> = {
  args: { value: "1250.50", label: "Amount", inputMode: "decimal" },
};
export const DateValue: Story<TextFieldProps> = {
  args: { value: "2026-11-04", label: "Date", type: "date" },
};
export const Password: Story<TextFieldProps> = {
  args: { value: "secret", label: "API key", type: "password", autoComplete: "off" },
};
export const Multiline: Story<TextFieldProps> = {
  args: { value: "First line\nSecond line", label: "Note", multiline: true, rows: 4 },
};
export const Invalid: Story<TextFieldProps> = {
  args: { value: "abc", label: "Amount", invalid: true },
};
export const Disabled: Story<TextFieldProps> = { args: { disabled: true } };
export const LabelHidden: Story<TextFieldProps> = { args: { labelHidden: true } };
export const Inline: Story<TextFieldProps> = { args: { inline: true } };
export const Combobox: Story<TextFieldProps> = {
  args: { value: "ACM", label: "Search", combobox: { controls: "story-results", expanded: true } },
};
export const FullWidth: Story<TextFieldProps> = { args: { className: "w-full" } };
export const WithNotes: Story<TextFieldProps> = {
  args: {
    value: "25",
    label: "Term",
    numeric: true,
    trailing: "years",
    before: "saved earlier",
    after: "Term from 1 to 50 years.",
    title: "Whole years",
  },
};
