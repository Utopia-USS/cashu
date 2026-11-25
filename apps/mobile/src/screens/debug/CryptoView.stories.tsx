// Stories of the crypto self-test panel (CSF 3, synthetic results).
import { CryptoView, type CryptoViewProps } from "./CryptoView";

const base: CryptoViewProps = {
  ok: true,
  checks: [
    { name: "knownAnswer", ok: true },
    { name: "vault", ok: true },
    { name: "frame", ok: true },
    { name: "frameTamper", ok: true },
    { name: "sealedBox", ok: true },
    { name: "sealedBoxWrongKey", ok: true },
    { name: "keyStore", ok: true },
  ],
  nativeAead: "unsupported_runtime",
  webCryptoRandom: true,
};

const meta = { title: "Mobile/Debug/Crypto", component: CryptoView, args: base };
export default meta;

export const Passed = { args: base };
export const BrokenRuntime = {
  args: {
    ...base,
    ok: false,
    checks: [{ name: "knownAnswer", ok: false, code: "unsupported_runtime" }],
    nativeAead: "not_run",
    webCryptoRandom: false,
  },
};
