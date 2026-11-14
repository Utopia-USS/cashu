import { market } from "@cashu/domain/investments";
import { investmentsCommands as C, setProfileSettings } from "@cashu/store";
import { InstrumentSearch } from "@cashu/store/investments/services";
import { afterEach, describe, expect, it } from "vitest";
import { investmentSearchIo } from "../providers/investmentAsyncTypes.js";
import { decodeEntityRef } from "../runtime/refs.js";
import { NativeMcpServer } from "../runtime/server.js";
import { asyncFixture, deferred } from "../testing/async.js";
import { investmentSearchAdapter } from "./investmentSearch.js";
import { investmentWriteTools } from "./investmentWrites.js";

const opened: ReturnType<typeof asyncFixture>[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.f.close();
});
const hits = market.parseYahooSearch(
  JSON.stringify({
    quotes: [
      { symbol: "ABC.WA", shortname: "Public Synthetic", quoteType: "EQUITY", exchange: "WSE" },
    ],
  }),
);
function setup() {
  const s = asyncFixture();
  opened.push(s);
  const entered = deferred<void>(),
    response = deferred<readonly market.SearchHit[]>();
  let sourceCalls = 0,
    closes = 0,
    current = true;
  const io = investmentSearchIo(
    s.f.vault,
    new InstrumentSearch(() => 1),
    () => ({
      symbols: {
        async search() {
          sourceCalls++;
          entered.resolve();
          return await response.promise;
        },
      },
      close() {
        closes++;
      },
    }),
    () => current,
  );
  s.services({ investmentAsync: { vault: s.f.vault, search: io } });
  const server = new NativeMcpServer(s.runtime, investmentWriteTools(), [investmentSearchAdapter]);
  return {
    ...s,
    server,
    io,
    entered,
    response,
    calls: () => sourceCalls,
    closes: () => closes,
    invalidate: () => {
      current = false;
    },
  };
}
describe("native investment search", () => {
  it("uses actual public lookup then current alias membership, opaque key and returned ref", async () => {
    const s = setup();
    const pending = s.server.call("search_instruments", { query: "unmatched" });
    await s.entered.promise;
    const added = s.f.run(C.addToWatchlist, {
      target: {
        planned: {
          symbol: "ABC",
          name: "Public Synthetic",
          currency: "PLN",
          assetClass: "equity",
          aliases: [{ namespace: "yahoo", value: "ABC.WA", guessed: false }],
        },
      },
    });
    if (!added.ok) throw new Error(added.reason);
    s.response.resolve(hits);
    const result = await pending;
    expect(result.ok).toBe(true);
    const data = result.data as {
      local: Record<string, string>[];
      remote: unknown[];
      remote_status: string;
    };
    expect(data.remote).toEqual([]);
    expect(data.local).toHaveLength(1);
    const row = data.local[0];
    if (!row) throw new Error("missing hit");
    expect(row.state).toBe("watched");
    expect(row.key).toBe(`i:${row.instrument_id}`);
    expect(decodeEntityRef("instrument", row.instrument_id ?? "")).toBe(added.value.instrument);
    expect(row.key).not.toContain(added.value.instrument);
    expect(data.remote_status).toBe("ok");
    expect(s.calls()).toBe(1);
    expect(s.closes()).toBe(1);
    expect(s.audit).toEqual(["start", "finish:strict:ok"]);
  });
  it("rebuilds name matches after await, excludes private names, and preserves source text labels", async () => {
    const s = setup();
    s.f.run(setProfileSettings, { mcpPrivacy: "amounts" });
    const pending = s.server.call("search_instruments", { query: "needle" });
    await s.entered.promise;
    expect(
      s.f.run(C.addToWatchlist, {
        target: {
          planned: { symbol: "PUB", name: "Public needle", currency: "PLN", assetClass: "equity" },
        },
      }).ok,
    ).toBe(true);
    expect(
      s.f.run(C.addToWatchlist, {
        target: {
          planned: { symbol: "OWN", name: "Private needle", currency: "PLN", assetClass: "other" },
        },
      }).ok,
    ).toBe(true);
    s.response.resolve([]);
    const result = await pending;
    const data = result.data as { local: { name: string }[] };
    // The new owner-named instrument protects its tokens in every public text field too.
    expect(data.local.map((r) => r.name)).toEqual(["Public [name]"]);
  });
  it("retains honest unavailable and skipped results without remote capabilities", async () => {
    const s = setup();
    s.services({});
    expect((await s.server.call("search_instruments", { query: "ABC" })).data).toMatchObject({
      remote_status: "unavailable",
    });
    expect((await s.server.call("search_instruments", { query: "A" })).data).toMatchObject({
      remote_status: "skipped",
    });
    expect(s.calls()).toBe(0);
  });
  it("rejects foreign capabilities before public resource access and currentness loss afterward", async () => {
    const s = setup();
    s.services({
      investmentAsync: {
        vault: s.f.vault,
        search: { ...s.io, vault: "22222222222222222222222222222222" },
      },
    });
    expect((await s.server.call("search_instruments", { query: "ABC" })).errorKind).toBe(
      "internal",
    );
    expect(s.calls()).toBe(0);
    s.services({ investmentAsync: { vault: s.f.vault, search: s.io } });
    const pending = s.server.call("search_instruments", { query: "ABC" });
    await s.entered.promise;
    s.invalidate();
    s.response.resolve(hits);
    expect((await pending).errorKind).toBe("unavailable");
  });
});
