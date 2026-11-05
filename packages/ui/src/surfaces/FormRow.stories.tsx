import type { Meta, Story } from "../charts/testing/csf.js";
import { FormRow, type FormRowProps } from "./FormRow.js";

const meta = {
  title: "Surfaces/FormRow",
  component: FormRow,
  args: { children: "Wartość | Waluta" },
} satisfies Meta<FormRowProps>;
export default meta;
export const Default: Story<FormRowProps> = {};
