// Synthetic stories shared by the DOM and native render tests.
import { type Meta, privacyMode, type Story } from "../charts/testing/csf.js";
import { UiEnvProvider } from "../environment/UiEnv.js";
import { DateText } from "./DateText.js";
import type { DateTextProps } from "./types.js";

const meta = {
  title: "Values/DateText",
  component: DateText,
  args: { value: "2026-10-01" },
} satisfies Meta<DateTextProps>;
export default meta;
export const Default: Story<DateTextProps> = {};
export const Missing: Story<DateTextProps> = { args: { value: null } };
export const PrivacyMode: Story<DateTextProps> = { decorators: [privacyMode] };
export const Polish: Story<DateTextProps> = {
  decorators: [
    (Story) => (
      <UiEnvProvider privacy={false} locale="pl-PL">
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const EnglishBritish: Story<DateTextProps> = {
  decorators: [
    (Story) => (
      <UiEnvProvider privacy={false} locale="en-GB">
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const Caption: Story<DateTextProps> = { args: { size: "caption" } };
export const Title: Story<DateTextProps> = { args: { size: "title" } };
export const Headline: Story<DateTextProps> = { args: { size: "headline" } };
export const Display: Story<DateTextProps> = { args: { size: "display" } };
export const Strong: Story<DateTextProps> = { args: { weight: "strong" } };
export const MutedTone: Story<DateTextProps> = { args: { tone: "muted" } };
export const PositiveTone: Story<DateTextProps> = { args: { tone: "positive" } };
export const NegativeTone: Story<DateTextProps> = { args: { tone: "negative" } };
export const Short: Story<DateTextProps> = { args: { dateStyle: "short" } };
export const Long: Story<DateTextProps> = { args: { dateStyle: "long" } };
export const LeapDay: Story<DateTextProps> = { args: { value: "2000-02-29" } };
