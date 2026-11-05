import type { Meta, Story } from "../charts/testing/csf.js";
import { Kicker, type KickerProps } from "./Kicker.js";

const meta = {
  title: "Surfaces/Kicker",
  component: Kicker,
  args: { title: "Co zatwierdzasz" },
} satisfies Meta<KickerProps>;
export default meta;
export const Default: Story<KickerProps> = {};
