import { render, screen } from "@testing-library/react-native";
import { CryptoView } from "../screens/debug/CryptoView";
import { runCryptoSelfTest } from "./cryptoSelfTest";
import { memoryKeyStore, runtime, withOpenFailure } from "./testing/runtime";

describe("native self-test diagnostics", () => {
  it.each([
    ["iOS", () => new Error("incorrect key pair for the given ciphertext")],
    [
      "Android",
      () => new Error("Exception in HostFunction: arbitrary native wording\n\nError: stack"),
    ],
  ])("renders the classified %s result as passed", async (_platform, failure) => {
    const result = await runCryptoSelfTest({
      lib: withOpenFailure(await runtime(), failure),
      keyStore: memoryKeyStore,
    });
    await render(<CryptoView {...result} webCryptoRandom />);
    expect(screen.getByText("All checks passed")).toBeOnTheScreen();
    expect(screen.getByText("sealedBoxWrongKey")).toBeOnTheScreen();
    expect(screen.queryByText("Self-test failed")).not.toBeOnTheScreen();
  });

  it.each([
    ["subclass", () => new TypeError("synthetic backend detail")],
    ["non-Error", () => ({ message: "synthetic backend detail" })],
  ])("renders an unknown %s failure as failed without raw diagnostics", async (_kind, failure) => {
    const result = await runCryptoSelfTest({
      lib: withOpenFailure(await runtime(), failure),
      keyStore: memoryKeyStore,
    });
    await render(<CryptoView {...result} webCryptoRandom />);
    expect(screen.getByText("Self-test failed")).toBeOnTheScreen();
    expect(screen.getByText("FAIL unsupported_runtime")).toBeOnTheScreen();
    expect(screen.queryByText("All checks passed")).not.toBeOnTheScreen();
    expect(screen.queryByText(/synthetic backend detail/)).not.toBeOnTheScreen();
  });
});
