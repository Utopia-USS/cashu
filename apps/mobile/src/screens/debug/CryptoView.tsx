// The crypto self-test panel of the debug screen: verdict, one line per check, the native AEAD probe.
import { S } from "./Debug.strings";
import { Line, Section } from "./parts";

export interface CryptoViewProps {
  readonly ok: boolean;
  readonly checks: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly code?: string;
  }[];
  readonly nativeAead: string;
  /** Whether the runtime has `crypto.getRandomValues` (the store's ULIDs and salts use it). */
  readonly webCryptoRandom: boolean;
}

export function CryptoView({ ok, checks, nativeAead, webCryptoRandom }: CryptoViewProps) {
  return (
    <Section title={S.crypto}>
      <Line
        label={ok ? S.cryptoOk : S.cryptoFailed}
        value={ok ? S.pass : S.fail}
        tone={ok ? "positive" : "negative"}
      />
      {checks.map((c) => (
        <Line
          key={c.name}
          label={c.name}
          value={c.ok ? S.pass : `${S.fail} ${c.code ?? ""}`}
          tone={c.ok ? "positive" : "negative"}
        />
      ))}
      <Line label={S.nativeAead} value={nativeAead} />
      <Line
        label={S.webCryptoRandom}
        value={webCryptoRandom ? S.pass : S.fail}
        tone={webCryptoRandom ? "positive" : "negative"}
      />
    </Section>
  );
}
