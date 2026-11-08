/** Read-only strategy service; file loading is the existing authorized port, never a view write. */

import type { UiLang } from "@cashu/domain/core";
import { type Currency, views } from "@cashu/domain/investments";
import type { StrategyStatus } from "@cashu/domain/investments/strategy";
import type { Read } from "../queries/shared.js";
import { strategyVersions } from "../queries/strategy.js";
import type { StrategyState } from "../services/strategy.js";

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
