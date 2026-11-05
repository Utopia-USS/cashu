import type { Meta, Story } from "../charts/testing/csf.js";
import { PrivacyLine, type PrivacyLineProps } from "./AgentWidget.js";

const meta = {
  title: "Surfaces/PrivacyLine",
  component: PrivacyLine,
  args: { privacy: "strict" },
} satisfies Meta<PrivacyLineProps>;
export default meta;
export const Strict: Story<PrivacyLineProps> = {};
export const Amounts: Story<PrivacyLineProps> = { args: { privacy: "amounts" } };
