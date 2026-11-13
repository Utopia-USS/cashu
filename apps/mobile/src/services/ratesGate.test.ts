import { createRatesGate } from "./ratesGate";

const HOUR = 3_600_000;

describe("createRatesGate", () => {
  it("lets a currency set run once an hour after a run that reached NBP", () => {
    const gate = createRatesGate();
    expect(gate.begin("EUR", 0)).toBe(true);
    gate.finish("EUR", 0, false);
    expect(gate.begin("EUR", HOUR - 1)).toBe(false);
    expect(gate.begin("EUR", HOUR)).toBe(true);
  });

  it("leaves the gate open after an offline run", () => {
    const gate = createRatesGate();
    expect(gate.begin("EUR", 0)).toBe(true);
    gate.finish("EUR", 0, true);
    expect(gate.begin("EUR", 1_000)).toBe(true);
  });

  it("never starts a second run of the same set while one is in flight", () => {
    const gate = createRatesGate();
    expect(gate.begin("EUR", 0)).toBe(true);
    expect(gate.begin("EUR", 10)).toBe(false);
    gate.finish("EUR", 0, true);
    expect(gate.begin("EUR", 20)).toBe(true);
  });

  it("runs a new currency set at once", () => {
    const gate = createRatesGate();
    expect(gate.begin("EUR", 0)).toBe(true);
    gate.finish("EUR", 0, false);
    expect(gate.begin("EUR,USD", 1)).toBe(true);
  });

  it("takes its interval: the prices gate opens again after 5 minutes", () => {
    const gate = createRatesGate(300_000);
    expect(gate.begin("vault", 0)).toBe(true);
    gate.finish("vault", 0, false);
    expect(gate.begin("vault", 299_999)).toBe(false);
    expect(gate.begin("vault", 300_000)).toBe(true);
  });
});
