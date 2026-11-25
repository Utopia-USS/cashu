// Synthetic stories shared by the DOM and native render tests.
import { D, Money as MoneyValue } from "@cashu/domain";
import { type Meta, privacyMode, type Story } from "../charts/testing/csf.js";
import { UiEnvProvider } from "../environment/UiEnv.js";
import { Money } from "./Money.js";
import type { MoneyProps } from "./types.js";

const meta = {
  title: "Values/Money",
  component: Money,
  args: { value: new MoneyValue(D("1234.56"), "PLN") },
} satisfies Meta<MoneyProps>;
export default meta;
export const Default: Story<MoneyProps> = {};
export const Missing: Story<MoneyProps> = { args: { value: null } };
export const PrivacyMode: Story<MoneyProps> = { decorators: [privacyMode] };
export const Polish: Story<MoneyProps> = {
  decorators: [
    (Story) => (
      <UiEnvProvider privacy={false} locale="pl-PL">
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const EnglishBritish: Story<MoneyProps> = {
  decorators: [
    (Story) => (
      <UiEnvProvider privacy={false} locale="en-GB">
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const Caption: Story<MoneyProps> = { args: { size: "caption" } };
export const Title: Story<MoneyProps> = { args: { size: "title" } };
export const Headline: Story<MoneyProps> = { args: { size: "headline" } };
export const Display: Story<MoneyProps> = { args: { size: "display" } };
export const Strong: Story<MoneyProps> = { args: { weight: "strong" } };
export const MutedTone: Story<MoneyProps> = { args: { tone: "muted" } };
export const PositiveTone: Story<MoneyProps> = { args: { tone: "positive" } };
export const NegativeTone: Story<MoneyProps> = { args: { tone: "negative" } };
export const Negative: Story<MoneyProps> = {
  args: { value: new MoneyValue(D("-1234.56"), "USD") },
};
export const Zero: Story<MoneyProps> = { args: { value: new MoneyValue(D("0"), "PLN") } };
export const Precision: Story<MoneyProps> = { args: { fractionDigits: 4 } };
export const ZeroMinorUnits: Story<MoneyProps> = {
  args: { value: new MoneyValue(D("1234.56"), "JPY") },
};
export const ThreeMinorUnits: Story<MoneyProps> = {
  args: { value: new MoneyValue(D("1234.5678"), "KWD") },
};
export const Large: Story<MoneyProps> = {
  args: { value: new MoneyValue(D("9007199254740993.12"), "USD") },
};
