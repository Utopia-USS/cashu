import type { Meta, Story } from "../charts/testing/csf.js";
import { Switch, type SwitchProps } from "./Switch.js";

const meta = {
  title: "Controls/Switch",
  component: Switch,
  args: { on: true, onChange: () => undefined, label: "Daily check" },
} satisfies Meta<SwitchProps>;
export default meta;
export const On: Story<SwitchProps> = {};
export const Off: Story<SwitchProps> = { args: { on: false } };
