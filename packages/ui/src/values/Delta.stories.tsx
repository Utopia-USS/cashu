// Synthetic stories shared by the DOM and native render tests.
import { D, Money as MoneyValue } from "@cashu/domain";
import { type Meta, privacyMode, type Story } from "../charts/testing/csf.js";
import { UiEnvProvider } from "../environment/UiEnv.js";
import { Delta } from "./Delta.js";
import type { DeltaProps } from "./types.js";

const meta = {
  title: "Values/Delta",
  component: Delta,
  args: { value: D("12.5"), kind: "amount" },
} satisfies Meta<DeltaProps>;
export default meta;
export const Default: Story<DeltaProps> = {};
export const Missing: Story<DeltaProps> = { args: { value: null } };
export const PrivacyMode: Story<DeltaProps> = { decorators: [privacyMode] };
export const Polish: Story<DeltaProps> = {
  decorators: [
    (Story) => (
      <UiEnvProvider privacy={false} locale="pl-PL">
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const EnglishBritish: Story<DeltaProps> = {
  decorators: [
    (Story) => (
      <UiEnvProvider privacy={false} locale="en-GB">
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const Caption: Story<DeltaProps> = { args: { size: "caption" } };
export const Title: Story<DeltaProps> = { args: { size: "title" } };
export const Headline: Story<DeltaProps> = { args: { size: "headline" } };
export const Display: Story<DeltaProps> = { args: { size: "display" } };
export const Strong: Story<DeltaProps> = { args: { weight: "strong" } };
export const Negative: Story<DeltaProps> = { args: { value: D("-12.5") } };
export const Zero: Story<DeltaProps> = { args: { value: D("0") } };
export const Precision: Story<DeltaProps> = { args: { fractionDigits: 4 } };
export const Monetary: Story<DeltaProps> = {
  args: { kind: "money", value: new MoneyValue(D("12.34"), "PLN") },
};
export const MonetaryPrivacy: Story<DeltaProps> = {
  args: { kind: "money", value: new MoneyValue(D("-12.34"), "PLN") },
  decorators: [privacyMode],
};
export const Ratio: Story<DeltaProps> = { args: { kind: "percent", value: D("0.125") } };
export const RatioPrivacy: Story<DeltaProps> = {
  args: { kind: "percent", value: D("0.125") },
  decorators: [privacyMode],
};
