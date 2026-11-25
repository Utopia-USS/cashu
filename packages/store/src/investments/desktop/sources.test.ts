import { strategyTemplate } from "@cashu/domain/investments/strategy";
import { expect, it } from "vitest";
import { createProfile } from "../../core/commands.js";
import { defineQuery, watchQuery } from "../../query.js";
import { saveStrategyVersion } from "../commands/strategy.js";
import { vault } from "../commands/testing/fixtures.js";
import { type CurrentStrategyImage, strategySnapshot } from "./sources.js";

it("rebases the unchanged actual file image on a tracked version event and distinguishes missing from failure", () => {
  const v = vault();
  v.value(createProfile, { slug: "synthetic", name: "Synthetic", modules: ["investments"] });
  const template = strategyTemplate("passive_etf");
  if (template === null) throw new Error("missing real template");
  const image: CurrentStrategyImage = {
    vault: v.store.vault,
    generation: "synthetic",
    revision: "one",
    files: { yaml: template.yaml, md: template.markdown, readError: null },
  };
  const values: ReturnType<typeof strategySnapshot>[] = [];
  const query = defineQuery({
    id: "test.currentStrategy",
    run: (read) => strategySnapshot(read, image),
  });
  const stop = watchQuery(v.store, query, undefined, {
    onValue: (value) => values.push(value),
    onError: (error) => {
      throw error;
    },
  });
  try {
    expect(values[0]).toMatchObject({ status: "current", state: { changed: true, version: null } });
    v.value(saveStrategyVersion, { yamlText: template.yaml, mdText: template.markdown });
    expect(values.at(-1)).toMatchObject({
      status: "current",
      state: { changed: false, version: { version: 1 } },
    });
    expect(
      strategySnapshot(v.store.read.bind(v.store), {
        ...image,
        files: { yaml: null, md: "Owner document", readError: null },
      }),
    ).toMatchObject({
      status: "current",
      state: { state: "missing", config: null, changed: false, version: { version: 1 } },
    });
    expect(
      strategySnapshot(v.store.read.bind(v.store), {
        ...image,
        files: { yaml: null, md: null, readError: "checked read failed" },
      }),
    ).toMatchObject({
      status: "current",
      state: { state: "invalid", readError: "checked read failed", config: null },
    });
    expect(
      strategySnapshot(v.store.read.bind(v.store), { ...image, vault: "f".repeat(32) }),
    ).toEqual({ status: "unavailable", reason: "invalid_identity" });
  } finally {
    stop();
    v.store.close();
  }
});
