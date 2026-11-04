import { expect, it } from "vitest";
import { commandHelp } from "./help.js";

it.each([
  [["invest", "accounts", "list"], "cashu invest accounts list"],
  [["invest", "accounts", "add"], "cashu invest accounts add NAME --broker"],
  [["invest", "strategy", "init"], "cashu invest strategy init [--template NAME] [--force]"],
  [["invest", "strategy", "validate"], "cashu invest strategy validate"],
  [["invest", "instruments", "merge"], "cashu invest instruments merge SOURCE TARGET"],
  [["assets", "add-position"], "cashu assets add-position NAME"],
  [["loans", "set-loan"], "cashu loans set-loan ACCOUNT_GID"],
  [["set-loan"], "cashu set-loan ACCOUNT_GID"],
  [["budget", "import-csv"], "cashu budget import-csv FILE [--bank BANK]"],
  [["budget", "import-dir"], "cashu budget import-dir [DIRECTORY] [--bank BANK]"],
] as const)("shows syntax for %j", (parts, expected) => {
  const help = commandHelp(parts);
  expect(help?.en).toContain(expected);
  expect(help?.pl).toContain("Użycie: cashu");
});
