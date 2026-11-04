/** Value components for the Signals Views: counts and one `ValueDisplay` in its unit. */
import { D } from "@cashu/domain";
import { Amount, Money, Percent } from "@cashu/ui";
import type { ValueDisplay } from "./alertModels.js";
import { G } from "./Signals.strings.js";

export function Count({ value }: { value: number }) {
  return <Amount value={D(String(value))} fractionDigits={0} />;
}

export function SignalValue({ value }: { value: ValueDisplay }) {
  switch (value.kind) {
    case "none":
      return "-";
    case "ratio":
      return <Percent value={value.value} />;
    case "multiple":
      return (
        <>
          <Amount value={value.value} fractionDigits={1} /> {G.multiple}
        </>
      );
    case "money":
      return <Money value={value.value} />;
    case "amount":
      return <Amount value={value.value} fractionDigits={value.fractionDigits} />;
  }
}
