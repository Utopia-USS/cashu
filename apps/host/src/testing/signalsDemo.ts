/** Synthetic Signals story for the explicit generated Electron data directory only. */
import { investmentsCommands } from "@cashu/store";
import type { OpenVault } from "../stores.js";
import { command } from "./worker.js";

export async function seedSignalsDemo(vault: OpenVault, today: string): Promise<void> {
  if (process.env.CASHU_TESTING !== "1" || process.env.CASHU_E2E_SIGNALS !== "1")
    throw new Error("synthetic Signals guard absent");
  const account = await command(vault, investmentsCommands.addBrokerageAccount, {
    name: "Synthetic Signals account",
    broker: "dif",
  });
  const held = await command(vault, investmentsCommands.createInstrument, {
    name: "Synthetic Signals holding",
    symbol: "S55F",
    mic: "XWAR",
    assetClass: "equity",
    currency: "PLN",
    aliases: [{ namespace: "yahoo", value: "S55F.WA", guessed: false }],
  });
  const watched = await command(vault, investmentsCommands.createInstrument, {
    name: "Synthetic Signals watched",
    symbol: "WATCH",
    mic: "XWAR",
    assetClass: "equity",
    currency: "PLN",
    aliases: [{ namespace: "yahoo", value: "WATCH.WA", guessed: false }],
  });
  await command(vault, investmentsCommands.addToWatchlist, { target: { stored: held.gid } });
  await command(vault, investmentsCommands.addToWatchlist, { target: { stored: watched.gid } });
  await command(vault, investmentsCommands.addManualTransaction, {
    account: account.account,
    type: "deposit",
    tradeDate: today,
    cashAmount: "1000",
    currency: "PLN",
  });
  await command(vault, investmentsCommands.addManualTransaction, {
    account: account.account,
    instrument: held.gid,
    type: "buy",
    tradeDate: today,
    quantity: "10",
    price: "10",
    currency: "PLN",
  });
  const alert = await command(vault, investmentsCommands.createAlert, {
    kind: "price_above",
    instrument: held.gid,
    title: "Synthetic Signals alert",
    params: { level: 20 },
  });
  const at = new Date().toISOString();
  const candidate = (
    ruleId: string,
    instrument: string,
    message: string,
    polarity: "positive" | "negative",
  ) => ({
    ruleId,
    kind: ruleId.startsWith("alert:") ? "alert:price_above" : "synthetic",
    dedupKey: `${ruleId}|i:${instrument}`,
    severity: "info",
    polarity,
    message,
    instrument,
    account: null,
    payload: {},
  });
  await command(vault, investmentsCommands.applySignalActions, {
    run: null,
    actions: [
      {
        type: "create",
        candidate: candidate(
          `alert:${alert.alert}`,
          held.gid,
          "Synthetic alert signal",
          "negative",
        ),
        createdAt: at,
      },
      {
        type: "create",
        candidate: candidate(
          "synthetic-watched",
          watched.gid,
          "Synthetic watched chance",
          "positive",
        ),
        createdAt: at,
      },
      ...Array.from({ length: 110 }, (_, index) => ({
        type: "create",
        candidate: candidate(
          `synthetic-${index}`,
          held.gid,
          `Synthetic holding signal ${index + 1}`,
          "negative",
        ),
        createdAt: at,
      })),
    ],
  });
}
