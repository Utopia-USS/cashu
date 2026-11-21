// Synthetic stories shared by the DOM and native render tests.
import { D } from "@cashu/domain";
import { type Meta, privacyMode, type Story } from "../charts/testing/csf.js";
import { UiEnvProvider } from "../environment/UiEnv.js";
import { Amount } from "./Amount.js";
import type { AmountProps } from "./types.js";

const meta = {
  title: "Values/Amount",
  component: Amount,
  args: { value: D("1234.56") },
} satisfies Meta<AmountProps>;
export default meta;
export const Default: Story<AmountProps> = {};
export const Missing: Story<AmountProps> = { args: { value: null } };
export const PrivacyMode: Story<AmountProps> = { decorators: [privacyMode] };
export const Polish: Story<AmountProps> = {
  decorators: [
    (Story) => (
      <UiEnvProvider privacy={false} locale="pl-PL">
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const EnglishBritish: Story<AmountProps> = {
  decorators: [
    (Story) => (
      <UiEnvProvider privacy={false} locale="en-GB">
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const Caption: Story<AmountProps> = { args: { size: "caption" } };
export const Title: Story<AmountProps> = { args: { size: "title" } };
export const Headline: Story<AmountProps> = { args: { size: "headline" } };
export const Display: Story<AmountProps> = { args: { size: "display" } };
export const Strong: Story<AmountProps> = { args: { weight: "strong" } };
export const MutedTone: Story<AmountProps> = { args: { tone: "muted" } };
export const PositiveTone: Story<AmountProps> = { args: { tone: "positive" } };
export const NegativeTone: Story<AmountProps> = { args: { tone: "negative" } };
export const Negative: Story<AmountProps> = { args: { value: D("-1234.56") } };
export const Zero: Story<AmountProps> = { args: { value: D("0") } };
export const Precision: Story<AmountProps> = { args: { fractionDigits: 4 } };
