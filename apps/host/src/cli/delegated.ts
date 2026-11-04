// TRANSITIONAL(S49): the Python CLI's top-level commands the host does not run yet, by the S39 slice
// that ports them (scopes-v2.md). The host answers each with `delegate`: the shim runs the Python CLI
// with its own terminal. A slice that ports a command moves it into the host's command tree and
// deletes its line here; the Python tree is checked against this table (delegated.test.ts), so a new
// Python command cannot slip through unrouted. Unknown commands, `--help` and parse errors at the root
// are delegated too (Python prints its own usage), until the last slice lands.
export const DELEGATED: Readonly<Record<string, string>> = {
  // TRANSITIONAL(S39a): core CLI
  accounts: "S39a",
  app: "S39a",
  "init-db": "S39a",
  mcp: "S39a",
  "migrate-data": "S39a",
  profiles: "S39a",
  secrets: "S39a",
  serve: "S39a",
  "set-account-name": "S39a",
  "set-account-type": "S39a",
  "set-balance": "S39a",
  stats: "S39a",
  sync: "S39a",
  // TRANSITIONAL(S39b): budget CLI and the Enable Banking client
  budget: "S39b",
  cash: "S39b",
  "cash-add": "S39b",
  categorize: "S39b",
  eb: "S39b",
  "import-csv": "S39b",
  "import-dir": "S39b",
  "match-transfers": "S39b",
  reclassify: "S39b",
  "set-category": "S39b",
  // TRANSITIONAL(S39c): loans and assets CLI
  "add-position": "S39c",
  assets: "S39c",
  loans: "S39c",
  "set-loan": "S39c",
  "set-vehicle": "S39c",
  // TRANSITIONAL(S39d): investments CLI
  invest: "S39d",
};
