import type { Decimal, Money } from "@cashu/domain";
import type { Layout } from "../layout.js";

export interface ValueStyle {
  readonly size?: "caption" | "body" | "title" | "headline" | "display";
  readonly tone?: "default" | "muted" | "positive" | "negative";
  readonly weight?: "regular" | "strong";
  readonly layout?: Layout;
}

export interface AmountProps extends ValueStyle {
  readonly value: Decimal | null;
  readonly fractionDigits?: number;
}
export interface MoneyProps extends ValueStyle {
  readonly value: Money | null;
  readonly fractionDigits?: number;
}
export type PercentProps = AmountProps;
export type DeltaProps = Omit<ValueStyle, "tone"> & { readonly fractionDigits?: number } & (
    | { readonly kind: "money"; readonly value: Money | null }
    | { readonly kind: "amount" | "percent"; readonly value: Decimal | null }
  );
export interface DateTextProps extends ValueStyle {
  readonly value: string | null;
  readonly dateStyle?: "short" | "medium" | "long";
}
