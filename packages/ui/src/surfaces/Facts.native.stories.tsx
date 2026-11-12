import { D, Money as MoneyValue } from "@cashu/domain";
import { type Meta, privacyMode, type Story } from "../charts/testing/csf.js";
import { Money } from "../values/Money.js";
import { Facts, type FactsProps } from "./Facts.js";

const pln = (amount: string) => (
  <Money value={new MoneyValue(D(amount), "PLN")} fractionDigits={0} size="title" weight="strong" />
);

const meta = {
  title: "Native/Facts",
  component: Facts,
  args: {
    items: [
      { label: "Money", value: pln("48200"), detail: "4 accounts" },
      { label: "Investments", value: pln("61789"), detail: "+0.9% this month" },
      { label: "Property", value: pln("820000") },
      { label: "Loans", value: pln("-412000"), detail: "mortgage" },
    ],
  },
} satisfies Meta<FactsProps>;
export default meta;
export const Four: Story<FactsProps> = {};
export const Odd: Story<FactsProps> = {
  args: {
    items: [
      { label: "Positions", value: "12" },
      { label: "Watched", value: "5" },
      { label: "Alerts", value: "1", detail: "since Monday" },
    ],
  },
};
export const PrivacyMode: Story<FactsProps> = { decorators: [privacyMode] };
