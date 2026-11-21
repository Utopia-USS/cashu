/** The importers the app knows, keyed by broker id. */

import { pyReprStr } from "../../pyRepr.js";
import { CanonicalImporter } from "./canonical/index.js";
import type { BrokerImporter, ImportFile } from "./contract.js";
import type { CsvMapping } from "./csvMapping.js";
import { GenericCsvImporter } from "./genericCsv.js";

/** An importer with the same broker id is already registered. */
export class DuplicateImporterError extends Error {
  constructor(brokerId: string) {
    super(`An importer with broker id ${pyReprStr(brokerId)} is already registered`);
    this.name = "DuplicateImporterError";
  }
}

/** Importers in registration order, keyed by `BrokerImporter.brokerId`. */
export class ImporterRegistry {
  private readonly byId = new Map<string, BrokerImporter>();

  constructor(importers: Iterable<BrokerImporter> = []) {
    for (const importer of importers) this.register(importer);
  }

  /** All importers in registration order. */
  get importers(): readonly BrokerImporter[] {
    return [...this.byId.values()];
  }

  get size(): number {
    return this.byId.size;
  }

  /** Add `importer`; throws `DuplicateImporterError` when its broker id is taken. */
  register(importer: BrokerImporter): void {
    if (this.byId.has(importer.brokerId)) throw new DuplicateImporterError(importer.brokerId);
    this.byId.set(importer.brokerId, importer);
  }

  /** The importer with `brokerId`, or undefined. */
  get(brokerId: string): BrokerImporter | undefined {
    return this.byId.get(brokerId);
  }

  has(brokerId: string): boolean {
    return this.byId.has(brokerId);
  }

  /**
   * Importers whose `canParse` accepts `file`, in registration order. An importer whose sniff throws
   * is treated as not matching.
   */
  detect(file: ImportFile): readonly BrokerImporter[] {
    return this.importers.filter((importer) => safeCanParse(importer, file));
  }
}

/** A foreign file must never break detection. */
export function safeCanParse(importer: BrokerImporter, file: ImportFile): boolean {
  try {
    return importer.canParse(file);
  } catch {
    return false;
  }
}

/** `default_registry(*mappings)`: the canonical importer first, then one generic CSV importer per mapping. */
export function defaultRegistry(...mappings: readonly CsvMapping[]): ImporterRegistry {
  return new ImporterRegistry([
    new CanonicalImporter(),
    ...mappings.map((mapping) => new GenericCsvImporter(mapping)),
  ]);
}
