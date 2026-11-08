// Every UiAction a client can dispatch, as the typed constants themselves (their ids are the wire ids).
// Two guards keep it honest: tools/arch `uiActions` checks that every `UiAction` constant of this
// package and every `useUiAction(...)` argument of the desktop renderer is listed here, and
// apps/host `productionActions.test.ts` checks that the production host wiring registers each one.

import { budgetStatementCommit, budgetStatementPreview } from "./budget/statement-import.js";
import { bankingSettings } from "./core/banking-settings.js";
import { classifierSettings } from "./core/classifier-settings.js";
import { proposalReview } from "./core/desktop-proposals/index.js";
import { connectorSettings, workspaceApply } from "./core/desktop-settings/index.js";
import { updateAction } from "./device/updates.js";
import { investmentImportCommit, investmentImportPreview } from "./investments/desktop/import.js";
import {
  signalsRemoveWatch,
  signalsSearch,
  signalsSnooze,
  signalsWatch,
} from "./investments/desktop-signals/actions.js";
import {
  strategyInit,
  strategyReadFile,
  strategyRefresh,
  strategyReload,
} from "./investments/desktop-strategies/index.js";
import type { UiAction } from "./ui-actions.js";

export const UI_ACTIONS: readonly UiAction<unknown, unknown>[] = [
  bankingSettings,
  budgetStatementCommit,
  budgetStatementPreview,
  classifierSettings,
  connectorSettings,
  investmentImportCommit,
  investmentImportPreview,
  proposalReview,
  signalsRemoveWatch,
  signalsSearch,
  signalsSnooze,
  signalsWatch,
  strategyInit,
  strategyReadFile,
  strategyRefresh,
  strategyReload,
  updateAction,
  workspaceApply,
];
