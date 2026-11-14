import type { Meta, Story } from "../charts/testing/csf.js";
import { ChoiceCard, type ChoiceCardProps } from "./ChoiceCard.js";

const meta = {
  title: "Controls/ChoiceCard",
  component: ChoiceCard,
  args: { checked: true, title: "Budżet", desc: "Wydatki, przepływy, subskrypcje.", onChange() {} },
} satisfies Meta<ChoiceCardProps>;
export default meta;
export const Default: Story<ChoiceCardProps> = {};
