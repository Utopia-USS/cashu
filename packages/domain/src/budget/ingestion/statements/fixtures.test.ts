/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureBytes, fixturePaths, REPO_ROOT } from "../testing/fixtures.js";

const CONNECTOR = { mbank: "mbank-csv", erste: "erste-csv", pekao: "pekao-csv" } as const;

describe("budget CSV fixtures", () => {
  it("the bank fixtures are byte copies of the connector fixtures while those exist", () => {
    const copies: [string, string][] = [
      ["mbank/mbank-zestawienie.csv", "mbank"],
      ["mbank/mbank-lista-operacji.csv", "mbank"],
      ["mbank/mbank-ekonto-walutowe-eur.csv", "mbank"],
      ["erste/erste-historia.csv", "erste"],
      ["erste/santander-legacy.csv", "erste"],
      ["pekao/pekao-historia.csv", "pekao"],
      ["pekao/pekao-historia-cp1250.csv", "pekao"],
    ];
    for (const [rel, bank] of copies) {
      const name = rel.split("/")[1] as string;
      const source = readFileSync(
        join(REPO_ROOT, "connectors", CONNECTOR[bank as keyof typeof CONNECTOR], "fixtures", name),
      );
      expect(Buffer.from(fixtureBytes(rel)).equals(source), rel).toBe(true);
    }
    expect(fixturePaths().length).toBe(27);
  });
});
