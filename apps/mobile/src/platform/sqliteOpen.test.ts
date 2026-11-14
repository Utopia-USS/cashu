// Every database of the app is opened encrypted: `openDatabaseSync` is called once in the app's sources,
// inside `openEncrypted` (sqlite.ts), so a new database file cannot be opened as plaintext by accident.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [join(__dirname, ".."), join(__dirname, "../../app")];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

it("opens SQLite only through openEncrypted", () => {
  const calls = ROOTS.flatMap(sources).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return [...text.matchAll(/\bopenDatabase(?:Sync|Async)?\s*\(/g)].map((m) => ({
      file,
      before: text.slice(0, m.index),
    }));
  });
  expect(calls.map((c) => c.file)).toEqual([join(__dirname, "sqlite.ts")]);
  const enclosing = calls[0]?.before.match(/function (\w+)\([^)]*\)[^{]*\{[^}]*$/)?.[1];
  expect(enclosing).toBe("openEncrypted");
});
