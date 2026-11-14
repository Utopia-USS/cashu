// Measurement output of the scaffold (S41): one JSON line per result in documents/bench/results.jsonl,
// read from the simulator's app container by the measurement script. Synthetic data only.
import { Directory, File, Paths } from "expo-file-system";

const benchDir = () => new Directory(Paths.document, "bench");

const CODE = /^[a-z0-9_-]{1,64}$/u;

/**
 * A value-free code for an error in a bench line: an error whose message is a code (`db_key_mismatch`)
 * keeps it, anything else is `unknown`. A raw message could quote a value from the store.
 */
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  // `String(error)` of an Error reads "Error: <message>".
  const bare = message.replace(/^[A-Za-z]*Error: /u, "");
  return CODE.test(bare) ? bare : "unknown";
}

export function appendBenchLog(input: Record<string, unknown>): void {
  // The log is plain text in <Documents>: an `error` field is only ever a code, whatever the caller passed.
  const entry = "error" in input ? { ...input, error: errorCode(input.error) } : input;
  const dir = benchDir();
  if (!dir.exists) dir.create({ intermediates: true });
  const file = new File(dir, "results.jsonl");
  const line = `${JSON.stringify({ at: Date.now(), ...entry })}\n`;
  if (!file.exists) file.create();
  file.writeSync(line, { append: true });
  console.log(`S41BENCH ${line.trim()}`);
}

/** Delete the measurement logs (the phone wipe); missing is not an error. */
export function deleteBenchLogs(): void {
  const dir = benchDir();
  if (dir.exists) dir.delete();
}
