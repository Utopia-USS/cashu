/** Actual command effects, post-fold instruments and existing name-source algorithms. */
import { investmentsCommands as C, runCommand, storeWriter, type v1 } from "@cashu/store";
import { loadInstrument } from "@cashu/store/investments/queries";
import { addWatchWithPlans } from "@cashu/store/investments/services";
import { afterEach, expect, it } from "vitest";
import { NameGuard } from "../privacy/names.js";
import { nativeFixture } from "../testing/native.js";
import { loadGuard } from "./index.js";
import { investmentNameSources } from "./investments.js";

const opened: ReturnType<typeof nativeFixture>[] = [];
afterEach(() => {
  for (const f of opened.splice(0)) f.close();
});
const sorted = (input: Iterable<string>) => [...input].sort();
it.each([
  { symbol: "OWN", name: "Synthetic Private Lender", assetClass: "other" },
  { symbol: "1234", name: "Synthetic Numeric Listing", assetClass: "equity" },
])("prospective name inputs equal actual post-fold facts for $assetClass", (spec) => {
  const f = nativeFixture();
  opened.push(f);
  const read = f.store.read.bind(f.store),
    profileId = BigInt(`0x${f.vault}`),
    key = new Uint8Array(32).fill(23);
  const before = loadGuard(read, profileId, key),
    pending: v1.Envelope[] = [];
  const out = runCommand(
    f.store,
    { append: (events) => pending.push(...events) },
    addWatchWithPlans(),
    {
      target: {
        planned: {
          ...spec,
          currency: "PLN",
          aliases: [{ namespace: "yahoo", value: `${spec.symbol}.WA`, guessed: true }],
        },
      },
      note: spec.name,
      source: "agent",
    },
    f.env,
  );
  if (!out.ok) throw new Error(out.reason);
  const prospective = out.value.prospectiveInstrument;
  expect(loadInstrument(read, prospective.id)).toBeUndefined();
  const composed = before.withProspectiveSources(profileId, [
    investmentNameSources([
      { inProfile: true, own: prospective, shared: prospective, overrideName: null },
    ]),
  ]);
  storeWriter(f.store).append(pending);
  expect(loadInstrument(read, prospective.id)).toEqual(prospective);
  const after = loadGuard(read, profileId, key);
  expect(sorted(composed.names)).toEqual(sorted(after.names));
  expect(sorted(composed.privatePayees)).toEqual(sorted(after.privatePayees));
  expect(sorted(composed.symbols)).toEqual(sorted(after.symbols));
  expect(composed.strictAliases).toEqual(after.strictAliases);
  expect(composed.mask(`This is ${spec.name}`)).toBe(after.mask(`This is ${spec.name}`));
  expect(composed.payeeRef("Synthetic Merchant")).toBe(after.payeeRef("Synthetic Merchant"));
});
it("retains existing protection and one lazy/cached secret lookup without exposing it", () => {
  let loads = 0;
  const base = new NameGuard({
    profileId: 1n,
    names: ["Existing Owner"],
    privatePayees: ["Synthetic Private Merchant"],
    strictAliases: [["Custom Alias", "Public Label"]],
    symbols: ["5678"],
    secret: () => {
      loads++;
      return new Uint8Array(32).fill(9);
    },
  });
  const merged = base.withProspectiveSources(1n, [
    investmentNameSources([
      {
        inProfile: true,
        own: {
          name: "New Private Owner",
          symbol: "OWN",
          assetClass: "other",
          valuationMode: "manual",
          isin: null,
        },
        shared: { name: "New Private Owner", symbol: "OWN", isin: null },
        overrideName: null,
      },
    ]),
  ]);
  expect(loads).toBe(0);
  expect(merged.payeeRef("Synthetic Private Merchant")).toBe(
    base.payeeRef("Synthetic Private Merchant"),
  );
  expect(loads).toBe(1);
  expect(merged.privatePayees).toEqual(base.privatePayees);
  expect(merged.strictAliases).toEqual(base.strictAliases);
  expect(merged.symbols.has("5678")).toBe(true);
  expect(merged.mask("Existing Owner and New Private Owner")).not.toContain("Owner");
  expect(() => base.withProspectiveSources(2n, [])).toThrow("profile mismatch");
  expect(loads).toBe(1);
});
it("uses the actual alias winner and grants no losing planned numeric-symbol exemption", () => {
  const f = nativeFixture();
  opened.push(f);
  const read = f.store.read.bind(f.store),
    profileId = BigInt(`0x${f.vault}`);
  const created = f.run(C.createInstrument, {
    symbol: "WIN",
    name: "Actual Winner",
    currency: "PLN",
    assetClass: "equity",
    aliases: [{ namespace: "yahoo", value: "1234.WA" }],
  });
  if (!created.ok) throw new Error(created.reason);
  const old = loadGuard(read, profileId, new Uint8Array(32).fill(23)),
    pending: v1.Envelope[] = [];
  const result = runCommand(
    f.store,
    { append: (events) => pending.push(...events) },
    addWatchWithPlans(),
    {
      target: {
        yahooSymbol: "1234.WA",
        planned: {
          symbol: "1234",
          name: "Losing Plan",
          currency: "PLN",
          assetClass: "equity",
          aliases: [{ namespace: "yahoo", value: "1234.WA" }],
        },
      },
      source: "agent",
    },
    f.env,
  );
  if (!result.ok) throw new Error(result.reason);
  expect(result.value.createdInstrument).toBe(false);
  expect(result.value.prospectiveInstrument.symbol).toBe("WIN");
  const inst = result.value.prospectiveInstrument;
  const merged = old.withProspectiveSources(profileId, [
    investmentNameSources([{ inProfile: true, own: inst, shared: inst, overrideName: null }]),
  ]);
  expect(merged.symbols.has("1234")).toBe(false);
  storeWriter(f.store).append(pending);
  expect(sorted(merged.symbols)).toEqual(
    sorted(loadGuard(read, profileId, new Uint8Array(32).fill(23)).symbols),
  );
});
