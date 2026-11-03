// What the host serves on the store channel: the queries and commands a `ui` session may use, by id.
// Anything not listed is refused (the renderer is sandboxed and not trusted). Same set as the S53 store
// process; screens add theirs here as they move onto the store (S55 series).
import {
  addCashExpense,
  type Command,
  cancelPlannedDeposit,
  createOverviewAsset,
  createPlannedDeposit,
  createProfile,
  deleteCashTransaction,
  removeOverviewAsset,
  renameProfile,
  restoreOverviewAsset,
  setCushion,
  setProfileSettings,
  setTransactionCategory,
  updateAssetDetails,
} from "@cashu/store";
import {
  budgetDesktopQueries,
  budgetScreenCashflow,
  budgetScreenCurrencies,
  budgetScreenSpending,
  setDesktopMerchantCategory,
} from "@cashu/store/budget/queries";
import { profile } from "@cashu/store/core";
import { currentVault, type DeviceCommand, setCurrentVault } from "@cashu/store/device";
import {
  researchScreenCommands,
  researchScreenQueries,
} from "@cashu/store/investments/research-screen";
import {
  reviewPositionDecision,
  reviewScreenQueries,
  saveReview,
  undoSavedReview,
} from "@cashu/store/investments/review-screen";
import type { InvestmentScreenSources } from "@cashu/store/investments/screen";
import {
  addUiManualTransaction,
  classifyUiInstrument,
  createUiBrokerageAccount,
  investmentDesktopQueries,
  uiThesisCommands,
  updateUiWatchNote,
} from "@cashu/store/investments/screen";
import {
  conditionalOwnerAcknowledge,
  signalsAlertCommands,
  signalsOwnerCommands,
  signalsQueries,
} from "@cashu/store/investments/signals-screen";
import { strategiesQueries } from "@cashu/store/investments/strategies-screen";
import { createUiLoan, loansScreen, setUiLoanPayment } from "@cashu/store/loans/screen";
import {
  legacyNavigation,
  type OverviewSources,
  overviewCashWallet,
  overviewQueries,
  profileIdentity,
  vaultPaymentPatterns,
} from "@cashu/store/overview";
import type { Query, QueryArgs } from "@cashu/store/query";

/** A vault command or a device command (its own `scope` says which store it writes). */
export type AnyCommand = Command<unknown, unknown> | DeviceCommand<unknown, unknown>;

/** Process-local providers are bound here, never supplied by the renderer. */
export function servedQueries(
  env: Parameters<typeof overviewQueries>[0] & {
    readonly legacyIdentity?: Parameters<typeof legacyNavigation>[0];
    readonly sources?: OverviewSources;
    readonly investments?: InvestmentScreenSources;
    readonly strategies?: Parameters<typeof strategiesQueries>[0];
    readonly signals?: Parameters<typeof signalsQueries>[0];
    readonly research?: Parameters<typeof researchScreenQueries>[0];
    readonly review?: Parameters<typeof reviewScreenQueries>[0];
  } = { prices: null },
): readonly Query<QueryArgs, unknown>[] {
  return [
    currentVault,
    profile,
    profileIdentity,
    vaultPaymentPatterns,
    legacyNavigation(env.legacyIdentity),
    overviewCashWallet,
    loansScreen,
    budgetScreenCashflow,
    budgetScreenCurrencies,
    budgetScreenSpending,
    ...Object.values(
      budgetDesktopQueries({
        ...(env.sources?.registry ? { registry: env.sources.registry } : {}),
        ...(env.sources?.plannedContribution
          ? { plannedContribution: env.sources.plannedContribution }
          : {}),
        paymentPatterns: (read) => vaultPaymentPatterns(read, env.sources),
      }),
    ),
    ...Object.values(overviewQueries(env, env.sources)),
    ...Object.values(investmentDesktopQueries(env.investments)),
    ...Object.values(strategiesQueries(env.strategies)),
    ...Object.values(signalsQueries(env.signals)),
    ...Object.values(researchScreenQueries(env.research)),
    ...Object.values(reviewScreenQueries(env.review)),
  ];
}

export const SERVED_COMMANDS: readonly AnyCommand[] = [
  ...Object.values(signalsOwnerCommands),
  saveReview,
  undoSavedReview,
  reviewPositionDecision,
  conditionalOwnerAcknowledge,
  addUiManualTransaction,
  createUiBrokerageAccount,
  classifyUiInstrument,
  updateUiWatchNote,
  ...Object.values(uiThesisCommands()),
  setCurrentVault,
  createProfile,
  renameProfile,
  setProfileSettings,
  setCushion,
  createUiLoan,
  setUiLoanPayment,
  setDesktopMerchantCategory,
  setTransactionCategory,
  addCashExpense,
  deleteCashTransaction,
  updateAssetDetails,
  removeOverviewAsset,
  restoreOverviewAsset,
  createPlannedDeposit,
  createOverviewAsset,
  cancelPlannedDeposit,
] as readonly AnyCommand[];

export function servedCommands(
  sources: {
    readonly strategy?: Parameters<typeof signalsAlertCommands>[0];
    readonly researchPlans?: Parameters<typeof researchScreenCommands>[0];
  } = {},
): readonly AnyCommand[] {
  return [
    ...SERVED_COMMANDS,
    ...Object.values(signalsAlertCommands(sources.strategy)),
    ...Object.values(researchScreenCommands(sources.researchPlans)),
  ] as readonly AnyCommand[];
}

export function isDeviceCommand(command: AnyCommand): command is DeviceCommand<unknown, unknown> {
  return "scope" in command && command.scope === "device";
}
