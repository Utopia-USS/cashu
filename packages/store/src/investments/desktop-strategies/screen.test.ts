import { describe, expect, it } from "vitest";
import { createProfile, setModules } from "../../core/commands.js";
import { vault } from "../commands/testing/fixtures.js";
import { type CurrentStrategyImage, strategySnapshot } from "../desktop/sources.js";
import { type StrategyDocumentsImage, saveStrategyVersion, strategiesQueries } from "./index.js";

const changes = { subscribe: () => () => {} };
function fixture() {
  const v = vault();
  v.value(createProfile, { slug: "synthetic", name: "Synthetic", modules: ["investments"] });
  const image: CurrentStrategyImage = {
    vault: v.store.vault,
    generation: "synthetic-generation",
    revision: "current-files",
    files: { yaml: null, md: "# Current prose", readError: null },
  };
  const documents: StrategyDocumentsImage = {
    vault: v.store.vault,
    generation: image.generation,
    revision: image.revision,
    documents: [],
    selected: null,
    paths: null,
    yamlExists: false,
    mdExists: true,
    canReload: true,
    canInit: false,
  };
  const q = strategiesQueries({
    strategy: { changes, current: (read) => strategySnapshot(read, image) },
    documents: { changes, current: () => documents },
  });
  return { v, image, documents, q, args: { lang: "en" as const, privacy: false, selection: null } };
}
describe("native Strategies query", () => {
  it("keeps missing current YAML distinct from stored history and MD", () => {
    const f = fixture();
    f.v.value(saveStrategyVersion, {
      yamlText: "version: 1\nbase_currency: PLN\n",
      mdText: "# Historical prose",
    });
    const result = f.q.screen.run(f.v.store.read.bind(f.v.store), f.args);
    expect(result.status).toBe("current");
    if (result.status !== "current") throw new Error("expected current");
    expect(result.strategy.state).toBe("missing");
    expect(result.strategy.changed).toBe(false);
    expect(result.strategy.facts).toBeNull();
    expect(result.versions).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("Historical prose");
    f.v.store.close();
  });
  it("lists a proposal with a malformed payload with empty summary values", () => {
    const f = fixture();
    const real = f.v.store.read.bind(f.v.store);
    const read = ((sql: string, ...params: Parameters<typeof real>[1][]) =>
      sql.includes("FROM proposals")
        ? [{ gid: "g1", summary: "Synthetic", kind: "strategy", payload: "{not json" }]
        : real(sql, ...params)) as typeof real;
    const result = f.q.screen.run(read, f.args);
    expect(result.proposals).toEqual([
      {
        gid: "g1",
        summary: "Synthetic",
        kind: "strategy",
        summaryCode: "strategy",
        summaryParams: {},
      },
    ]);
    f.v.store.close();
  });
  it("never sends prose, paths or reasons while privacy is enabled", () => {
    const f = fixture();
    const result = f.q.screen.run(f.v.store.read.bind(f.v.store), { ...f.args, privacy: true });
    expect(result).toEqual({
      status: "unavailable",
      reason: "privacy",
      proposals: [],
      versions: [],
    });
    f.v.store.close();
  });
  it("refuses current metadata from a different revision", () => {
    const f = fixture();
    const q = strategiesQueries({
      strategy: { changes, current: (read) => strategySnapshot(read, f.image) },
      documents: { changes, current: () => ({ ...f.documents, revision: "different" }) },
    });
    expect(q.screen.run(f.v.store.read.bind(f.v.store), f.args).status).toBe("unavailable");
    f.v.store.close();
  });
  it("distinguishes read error from missing, without using history as a fallback", () => {
    const f = fixture();
    const q = strategiesQueries({
      strategy: {
        changes,
        current: (read) =>
          strategySnapshot(read, {
            ...f.image,
            files: { yaml: null, md: null, readError: "synthetic read failure" },
          }),
      },
      documents: { changes, current: () => f.documents },
    });
    const result = q.screen.run(f.v.store.read.bind(f.v.store), f.args);
    expect(result.status === "current" && result.strategy.read_error).toBe(
      "synthetic read failure",
    );
    f.v.store.close();
  });
  it("disabled module never calls a private file provider", () => {
    const f = fixture();
    f.v.value(setModules, { moduleIds: [] });
    const q = strategiesQueries({
      strategy: {
        changes,
        current() {
          throw new Error("private provider accessed");
        },
      },
    });
    expect(q.screen.run(f.v.store.read.bind(f.v.store), f.args)).toEqual({
      status: "unavailable",
      reason: "module_disabled",
      proposals: [],
      versions: [],
    });
    f.v.store.close();
  });
});
