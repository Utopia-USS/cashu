// Synthetic stories shared by the DOM and native render tests.
import { D } from "@cashu/domain";
import { type Meta, privacyMode, type Story } from "../charts/testing/csf.js";
import { UiEnvProvider } from "../environment/UiEnv.js";
import { Percent } from "./Percent.js";
import type { PercentProps } from "./types.js";

const meta = {
  title: "Values/Percent",
  component: Percent,
  args: { value: D("0.125") },
} satisfies Meta<PercentProps>;
export default meta;
export const Default: Story<PercentProps> = {};
export const Missing: Story<PercentProps> = { args: { value: null } };
export const PrivacyMode: Story<PercentProps> = { decorators: [privacyMode] };
export const Polish: Story<PercentProps> = {
  decorators: [
    (Story) => (
      <UiEnvProvider privacy={false} locale="pl-PL">
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const EnglishBritish: Story<PercentProps> = {
  decorators: [
    (Story) => (
      <UiEnvProvider privacy={false} locale="en-GB">
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const Caption: Story<PercentProps> = { args: { size: "caption" } };
export const Title: Story<PercentProps> = { args: { size: "title" } };
export const Headline: Story<PercentProps> = { args: { size: "headline" } };
export const Display: Story<PercentProps> = { args: { size: "display" } };
export const Strong: Story<PercentProps> = { args: { weight: "strong" } };
export const MutedTone: Story<PercentProps> = { args: { tone: "muted" } };
export const PositiveTone: Story<PercentProps> = { args: { tone: "positive" } };
export const NegativeTone: Story<PercentProps> = { args: { tone: "negative" } };
export const Negative: Story<PercentProps> = { args: { value: D("-0.125") } };
export const Zero: Story<PercentProps> = { args: { value: D("0") } };
export const Precision: Story<PercentProps> = { args: { fractionDigits: 4 } };
