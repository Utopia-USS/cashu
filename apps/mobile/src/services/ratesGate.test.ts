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

  it("keeps one timestamp per key: A -> B -> A inside the interval does not fetch A again", () => {
    const gate = createRatesGate(300_000);
    expect(gate.begin("vault-a", 0)).toBe(true);
    gate.finish("vault-a", 0, false);
    expect(gate.begin("vault-b", 10_000)).toBe(true);
    gate.finish("vault-b", 10_000, false);
    expect(gate.begin("vault-a", 20_000)).toBe(false);
    expect(gate.begin("vault-b", 30_000)).toBe(false);
    expect(gate.begin("vault-a", 300_000)).toBe(true);
    expect(gate.begin("vault-b", 300_000)).toBe(false);
  });

  it("tracks the run in flight per key: B starting does not let A start twice", () => {
    const gate = createRatesGate(300_000);
    expect(gate.begin("vault-a", 0)).toBe(true);
    expect(gate.begin("vault-b", 1)).toBe(true);
    expect(gate.begin("vault-a", 2)).toBe(false);
    gate.finish("vault-b", 1, true);
    expect(gate.begin("vault-a", 3)).toBe(false);
  });
});
