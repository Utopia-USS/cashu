// Synthetic stories of the phone's hero figure (native render test: native-display.native.test.tsx).
import { D, Money as MoneyValue } from "@cashu/domain";
import { bananaScale } from "@cashu/domain/core";
import { type Decorator, type Meta, privacyMode, type Story } from "../charts/testing/csf.js";
import { UiEnvProvider } from "../environment/UiEnv.js";
import { Figure, type FigureProps } from "./Figure.js";

const english: Decorator = (Story) => (
  <UiEnvProvider privacy={false} locale="en-US">
    <Story />
  </UiEnvProvider>
);
const polish: Decorator = (Story) => (
  <UiEnvProvider privacy={false} locale="pl-PL">
    <Story />
  </UiEnvProvider>
);
const inBananas: Decorator = (Story) => (
  <UiEnvProvider privacy locale="en-US" bananas={bananaScale("salary", D("8000"), { EUR: 4.25 })}>
    <Story />
  </UiEnvProvider>
);

const meta = {
  title: "Native/Figure",
  component: Figure,
  args: { value: new MoneyValue(D("14220.55"), "PLN") },
  decorators: [english],
} satisfies Meta<FigureProps>;
export default meta;
export const Pln: Story<FigureProps> = {};
export const Eur: Story<FigureProps> = { args: { value: new MoneyValue(D("1240"), "EUR") } };
export const Polish: Story<FigureProps> = { decorators: [polish] };
export const Whole: Story<FigureProps> = { args: { fractionDigits: 0 } };
export const Sheet: Story<FigureProps> = { args: { size: "sheet" } };
export const Card: Story<FigureProps> = { args: { size: "card", fractionDigits: 0 } };
export const Negative: Story<FigureProps> = {
  args: { value: new MoneyValue(D("-3410"), "PLN"), tone: "negative" },
};
export const PrivacyMasked: Story<FigureProps> = { decorators: [privacyMode] };
export const PrivacyBananas: Story<FigureProps> = { decorators: [inBananas] };
export const Missing: Story<FigureProps> = { args: { value: null } };
