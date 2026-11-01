// TRANSITIONAL(S49): a fake `cashu` CLI for the sync service tests (run as a real child process, as the
// service runs Python): `sync ack --through N --ids F` marks the synthetic outbox rows acked,
// `sync apply --stdin` counts the piped events, `sync seed` answers. The database is FAKE_CASHU_DB.
// Synthetic data only.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const db = new DatabaseSync(process.env.FAKE_CASHU_DB ?? ":memory:");
const at = args.indexOf("sync");
const command = args[at + 1];
if (command === "ack") {
  const through = Number(args[args.indexOf("--through") + 1]);
  const ids = readFileSync(args[args.indexOf("--ids") + 1] ?? "", "utf8");
  db.prepare("UPDATE sync_outbox SET acked_at = ? WHERE id <= ? AND acked_at IS NULL").run(
    "2026-03-01 10:00:00.000000",
    through,
  );
  process.stdout.write(
    `${JSON.stringify({ acked: through, entries: ids.split("\n").length - 1 })}\n`,
  );
} else if (command === "apply") {
  const lines = readFileSync(0, "utf8").split("\n").filter(Boolean);
  process.stdout.write(`${JSON.stringify({ applied: lines.length })}\n`);
} else if (command === "seed") {
  process.stdout.write(`${JSON.stringify({ inserted: 0 })}\n`);
} else {
  process.exitCode = 2;
}
db.close();
