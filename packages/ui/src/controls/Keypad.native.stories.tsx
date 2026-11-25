import type { Meta, Story } from "../charts/testing/csf.js";
import { Keypad, type KeypadProps } from "./Keypad.js";

const meta = {
  title: "Native/Keypad",
  component: Keypad,
  args: { onKey: () => {}, backspaceLabel: "Delete" },
} satisfies Meta<KeypadProps>;
export default meta;
export const Default: Story<KeypadProps> = {};
export const CommaDecimal: Story<KeypadProps> = { args: { decimalLabel: "," } };
