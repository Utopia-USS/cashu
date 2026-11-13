// Measurement output of the scaffold (S41): one JSON line per result in documents/bench/results.jsonl,
// read from the simulator's app container by the measurement script. Synthetic data only.
import { Directory, File, Paths } from "expo-file-system";

const benchDir = () => new Directory(Paths.document, "bench");

export function appendBenchLog(entry: Record<string, unknown>): void {
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
