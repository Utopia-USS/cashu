// Closing one services instance: client first, every part closed once even when one throws.
import { servicesCloser } from "./lifecycle";

function parts(failing?: string) {
  const log: string[] = [];
  const part = (name: string) => ({
    close: () => {
      log.push(name);
      if (name === failing) throw new Error(`${name} failed`);
    },
  });
  return {
    log,
    parts: {
      client: { dispose: () => void log.push("client") },
      vaults: [part("vault a"), part("vault b")],
      prices: part("prices"),
      device: part("device"),
    },
  };
}

describe("services close", () => {
  it("disposes the client, then closes the vaults, the price cache and the device store, once", () => {
    const { log, parts: p } = parts();
    const close = servicesCloser(p);
    close();
    close();
    expect(log).toEqual(["client", "vault a", "vault b", "prices", "device"]);
  });

  it("closes the rest when one part throws and rethrows that failure", () => {
    const { log, parts: p } = parts("vault a");
    const close = servicesCloser(p);
    expect(close).toThrow("vault a failed");
    expect(log).toEqual(["client", "vault a", "vault b", "prices", "device"]);
    close();
    expect(log).toHaveLength(5);
  });
});
