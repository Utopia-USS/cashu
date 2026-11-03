// Synthetic real-store test kit for native money screens. No platform SQLite/keychain boot and no
// mocked useQuery: the synchronous client watches actual event-folded vaults and a DeviceStore.
import { D } from "@cashu/domain";
import type { RawTransaction } from "@cashu/domain/budget";
import {
  betterSqlite3Driver,
  builtinModules,
  type Command,
  createProfile,
  HybridClock,
  importStatement,
  runCommand,
  Store,
  storeWriter,
  vaultSalt,
} from "@cashu/store";
import { DeviceStore, setCurrentVault } from "@cashu/store/device";
import { createSyncClient, type VaultHandle } from "@cashu/store-react/local";
import Database from "better-sqlite3";
import { createMoneyQueries, type MoneyQueryContext } from "../../services/moneyQueries";
import type { Services } from "../../services/services";

const MONEY_VAULT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaa261";
export const MONEY_VAULT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbb262";
const DEVICE = "ccccccccccccccccccccccccccccc263";
export const MONEY_OWN_A = "PL10114000000000000000001234";
export const MONEY_OWN_B = "PL10124000000000000000003334";
export const MONEY_EURO = "PL10114000000000000000005678";

export function applyMoneyCommand<I, R>(
  handle: VaultHandle,
  command: Command<I, R>,
  input: unknown,
): R {
  const result = runCommand(handle.store, handle.writer, command, input, handle.env);
  if (!result.ok) throw new Error(`synthetic money command refused: ${result.reason}`);
  return result.value;
}

function openMoneyVault(vault: string, name: string): VaultHandle {
  const store = Store.open({
    driver: betterSqlite3Driver(new Database(":memory:")),
    vault,
    salt: vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => i)),
    modules: builtinModules(),
  });
  let wall = Date.UTC(2026, 9, 31, 12);
  const clock = { now: () => wall++ };
  let seed = 26;
  const handle: VaultHandle = {
    store,
    writer: storeWriter(store),
    env: {
      device: DEVICE,
      clock,
      hlc: new HybridClock(DEVICE, { physical: clock }),
      // Test owner only. This is not a production authority provider.
      lease: { isHolder: () => true },
      random: (n) =>
        Uint8Array.from({ length: n }, () => {
          seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
          return seed >>> 24;
        }),
    },
  };
  applyMoneyCommand(handle, createProfile, {
    slug: "synthetic-money",
    name,
    baseCurrency: "PLN",
    modules: ["budget"],
  });
  return handle;
}

export function moneyStore(context: MoneyQueryContext = { prices: null }) {
  const a = openMoneyVault(MONEY_VAULT_A, "Synthetic A");
  const b = openMoneyVault(MONEY_VAULT_B, "Synthetic B");
  const device = DeviceStore.open(betterSqlite3Driver(new Database(":memory:")));
  device.run(setCurrentVault, { vault: MONEY_VAULT_A });
  const client = createSyncClient(
    {
      device,
      vaults: new Map([
        [MONEY_VAULT_A, a],
        [MONEY_VAULT_B, b],
      ]),
    },
    { lingerMs: 0 },
  );
  const services: Services = {
    client,
    moneyQueries: createMoneyQueries(context),
    store: a.store,
    openMs: 0,
    firstLoad: null,
    // Unused by money screens. These tests never claim a crypto self-test ran.
    cryptoSelfTest: Promise.resolve({ checks: [], ok: false, nativeAead: "not_run" }),
  };
  return {
    a,
    b,
    device,
    client,
    services,
    close() {
      client.dispose();
      device.close();
      a.store.close();
      b.store.close();
    },
  };
}

export type MoneyStore = ReturnType<typeof moneyStore>;

export interface MoneyFact {
  readonly date: string;
  readonly amount: string;
  readonly key: string;
  readonly iban?: string;
}

export function importMoneyFacts(
  handle: VaultHandle,
  currency: string,
  account: string,
  facts: readonly MoneyFact[],
): string {
  const transactions: RawTransaction[] = facts.map((fact) => ({
    bookingDate: fact.date,
    valueDate: null,
    amount: D(fact.amount),
    currency,
    counterpartyName: "Synthetic counterparty",
    counterpartyIban: fact.iban ?? null,
    description: fact.key,
    reference: fact.key,
    bankTransactionId: null,
    source: "csv",
    raw: { synthetic: fact.key },
  }));
  const result = applyMoneyCommand(handle, importStatement, {
    statement: {
      bank: "mbank",
      accountNumber: account,
      accountName: "Synthetic account",
      currency,
      transactions,
      balances: [],
      closingBalances: [],
    },
    newestDayRule: false,
  });
  return result.account;
}
