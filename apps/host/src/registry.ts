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
import type { InvestmentScreenSources } from "@cashu/store/investments/screen";
import {
  addUiManualTransaction,
  classifyUiInstrument,
  createUiBrokerageAccount,
  investmentDesktopQueries,
  uiThesisCommands,
  updateUiWatchNote,
} from "@cashu/store/investments/screen";
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
  ];
}

export const SERVED_COMMANDS: readonly AnyCommand[] = [
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

export function isDeviceCommand(command: AnyCommand): command is DeviceCommand<unknown, unknown> {
  return "scope" in command && command.scope === "device";
}
