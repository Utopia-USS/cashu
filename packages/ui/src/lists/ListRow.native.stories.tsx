import { D, Money as MoneyValue } from "@cashu/domain";
import { type Meta, privacyMode, type Story } from "../charts/testing/csf.js";
import { Money } from "../values/Money.js";
import { DateLead, ListRow, type ListRowProps } from "./ListRow.js";
import { Swatch } from "./Swatch.js";

const meta = {
  title: "Native/ListRow",
  component: ListRow,
  args: {
    lead: <DateLead date="2026-11-12" />,
    name: "Grocery store",
    value: <Money value={new MoneyValue(D("-89.99"), "PLN")} weight="strong" />,
    sub: "Groceries",
  },
} satisfies Meta<ListRowProps>;
export default meta;
export const Default: Story<ListRowProps> = {};
export const First: Story<ListRowProps> = { args: { first: true } };
export const TwoCaptions: Story<ListRowProps> = {
  args: {
    lead: <Swatch color="palette-2" />,
    name: "Groceries",
    value: "1,240",
    sub: "12 payments",
    sub2: "usual 1,100",
  },
};
export const NameOnly: Story<ListRowProps> = {
  args: { lead: undefined, value: undefined, sub: undefined },
};
export const Dim: Story<ListRowProps> = { args: { dim: true, sub: "Paid" } };
export const Pressable: Story<ListRowProps> = {
  args: { onPress: () => {}, accessibilityLabel: "Grocery store, open the transaction" },
};
export const PrivacyMode: Story<ListRowProps> = { decorators: [privacyMode] };
