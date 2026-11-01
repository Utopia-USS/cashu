// The cushion diff (S31a spec 4.6, D7a): shipped once per changed file value, compared with the last
// shipped value, never for a missing or invalid file. Synthetic files only.
import { describe, expect, it } from "vitest";
import { cushionShip } from "./cushion.js";
import { idsOf, testPorts, vaultInput } from "./testing/rows.js";

const utf8 = new TextEncoder();
const AT = "2026-03-02T11:00:00Z";

function withFile(text: string | undefined) {
  const input = vaultInput(idsOf({}));
  const files = {
    read: (rel: string) =>
      rel === "profiles/syn/budget.json" && text !== undefined ? utf8.encode(text) : undefined,
    list: () => [],
  };
  return { ...input, files };
}

describe("cushionShip", () => {
  it("ships budgetSettings.cushionSet when the value differs from the last shipped one", () => {
    const vault = withFile('{"cushion": {"enabled": true, "target_months": 3}}');
    const first = cushionShip(vault, "syn", undefined, AT, testPorts());
    expect(first?.events.map((e) => [e.t, e.a, e.o])).toEqual([
      ["budgetSettings.cushionSet", AT, "bridge"],
    ]);
    expect(cushionShip(vault, "syn", first?.value, AT, testPorts())).toBeUndefined();
    const changed = withFile('{"cushion": {"enabled": true, "target_months": 6}}');
    expect(cushionShip(changed, "syn", first?.value, AT, testPorts())?.events.length).toBe(1);
  });

  it("ships nothing for a missing or invalid file", () => {
    expect(cushionShip(withFile(undefined), "syn", undefined, AT, testPorts())).toBeUndefined();
    expect(cushionShip(withFile("{not json"), "syn", undefined, AT, testPorts())).toBeUndefined();
  });
});
