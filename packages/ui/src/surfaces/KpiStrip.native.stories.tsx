import { D, Money as MoneyValue } from "@cashu/domain";
import { type Meta, privacyMode, type Story } from "../charts/testing/csf.js";
import { Money } from "../values/Money.js";
import { KpiStrip, type KpiStripProps } from "./KpiStrip.js";

const pln = (amount: string) => (
  <Money value={new MoneyValue(D(amount), "PLN")} fractionDigits={0} size="title" weight="strong" />
);

const meta = {
  title: "Native/KpiStrip",
  component: KpiStrip,
  args: {
    items: [
      { label: "Income", value: pln("9800") },
      { label: "Spent", value: pln("6120") },
    ],
  },
} satisfies Meta<KpiStripProps>;
export default meta;
export const Two: Story<KpiStripProps> = {};
export const Three: Story<KpiStripProps> = {
  args: {
    items: [
      { label: "Income", value: pln("9800") },
      { label: "Spent", value: pln("6120") },
      { label: "Bills due", value: "3" },
    ],
  },
};
export const PrivacyMode: Story<KpiStripProps> = { decorators: [privacyMode] };
