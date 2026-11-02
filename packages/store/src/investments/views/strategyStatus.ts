/** Read-only strategy service; file loading is the existing authorized port, never a view write. */

import type { UiLang } from "@cashu/domain/core";
import { type Currency, views } from "@cashu/domain/investments";
import type { StrategyStatus } from "@cashu/domain/investments/strategy";
import type { Store } from "../../materialize.js";
import type { Read } from "../queries/shared.js";
import { strategyVersions } from "../queries/strategy.js";
import { loadStrategy, type StrategyFilesPort, type StrategyState } from "../services/strategy.js";

const { strategyStatusView } = views;
type StrategyFileFacts = views.StrategyFileFacts;

export function nativeStrategyStatus(state: StrategyState): StrategyStatus {
  return {
    state: state.state,
    result: state.result,
    sha256: state.sha256,
    latest: state.version,
    changed: state.changed,
    readError: state.readError,
  };
}

export function projectStoredStrategyStatus(
  read: Read,
  request: {
    readonly state: StrategyState;
    readonly files: StrategyFileFacts;
    readonly profileBase: Currency;
    readonly lang: UiLang;
  },
) {
  const status = nativeStrategyStatus(request.state);
  return strategyStatusView({
    status,
    profileBase: request.profileBase,
    files: request.files,
    lang: request.lang,
    versions: strategyVersions(read),
  });
}

/** No cached DTO: a file-only edit or read failure must be visible on the next explicit read. */
export async function readStrategyStatus(
  store: Store,
  request: {
    readonly files: StrategyFilesPort;
    readonly paths: { readonly yaml: string; readonly md: string };
    readonly profileBase: Currency;
    readonly lang: UiLang;
  },
) {
  const state = await loadStrategy(store, request.files);
  const [yamlExists, mdExists] = await Promise.all([
    request.files.exists("strategy.yaml"),
    request.files.exists("strategy.md"),
  ]);
  return projectStoredStrategyStatus(store.read.bind(store), {
    state,
    profileBase: request.profileBase,
    lang: request.lang,
    files: { ...request.paths, yamlExists, mdExists },
  });
}
