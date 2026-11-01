// The mobile JS bundle budget (cashu-ts-architecture references/performance.md, "Bundles": Hermes
// bytecode <= 4 MB). Exports the production bundle per platform with `expo export` (the same Metro
// build a Release app embeds), reads the .hbc size and exits 1 above the budget. The budget number is
// read from performance.md itself, so the doc stays the one source; changing it needs the lead.
//   usage: node scripts/bundle-size.mjs [--platform ios|android] [--report]
//   --report additionally exports plain JS with a source map and prints the largest owners (npm
//   package, or workspace package/area), to find what an import pulled in.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const PERFORMANCE_MD = join(
  APP,
  "../../tools/claude-dev/skills/cashu-ts-architecture/references/performance.md",
);

/** The budget in bytes (decimal MB, as the measurements report them). */
function budgetBytes() {
  const line = readFileSync(PERFORMANCE_MD, "utf8")
    .split("\n")
    .find((l) => l.startsWith("| Bundles |"));
  const match = line?.match(/mobile JS \(Hermes bytecode\) <= (\d+(?:\.\d+)?) MB/);
  if (!match) throw new Error(`no "mobile JS (Hermes bytecode) <= N MB" in ${PERFORMANCE_MD}`);
  return Math.round(Number(match[1]) * 1_000_000);
}

function exportBundle(platform, outDir, extra) {
  execFileSync(
    "npx",
    ["expo", "export", "--platform", platform, "--output-dir", outDir, ...extra],
    { cwd: APP, stdio: ["ignore", "ignore", "inherit"] },
  );
  const dir = join(outDir, "_expo/static/js", platform);
  return readdirSync(dir).map((f) => join(dir, f));
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decoded segments of one v3 map: [line, column, source name or null], absolute positions. */
function segmentsOf(map, lineBase, columnBase, out) {
  if (map.sections) {
    for (const s of map.sections) segmentsOf(s.map, lineBase + s.offset.line, s.offset.column, out);
    return;
  }
  let source = 0;
  map.mappings.split(";").forEach((segments, lineNo) => {
    let column = lineNo === 0 ? columnBase : 0;
    for (const segment of segments.split(",")) {
      if (!segment) continue;
      const fields = [];
      let value = 0;
      let shift = 0;
      for (const ch of segment) {
        const digit = B64.indexOf(ch);
        value += (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else {
          fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      column += fields[0];
      if (fields.length > 1) source += fields[1];
      out.push([lineBase + lineNo, column, fields.length > 1 ? map.sources[source] : null]);
    }
  });
}

/** Bytes of generated code per source file: each segment runs to the next one or the line end. */
function bytesPerSource(js, map) {
  const lines = js.split("\n");
  const segments = [];
  segmentsOf(map, 0, 0, segments);
  segments.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = new Map();
  segments.forEach(([line, column, source], i) => {
    if (!source) return;
    const next = segments[i + 1];
    const end = next && next[0] === line ? next[1] : (lines[line]?.length ?? column);
    out.set(source, (out.get(source) ?? 0) + end - column);
  });
  return [...out];
}

function owner(source) {
  const npm = source.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/);
  if (npm) return npm[1];
  const ws = source.match(/(packages|apps)\/([^/]+)\/src\/([^/.]+)/);
  return ws ? `${ws[1]}/${ws[2]}/${ws[3]}` : source;
}

function report(platform) {
  const dir = mkdtempSync(join(tmpdir(), "cashu-bundle-js-"));
  try {
    const js = exportBundle(platform, dir, ["--no-bytecode", "--source-maps"]).find((f) =>
      f.endsWith(".js"),
    );
    const code = readFileSync(js, "utf8");
    const byOwner = new Map();
    for (const [source, bytes] of bytesPerSource(code, JSON.parse(readFileSync(`${js}.map`)))) {
      const key = owner(source);
      byOwner.set(key, (byOwner.get(key) ?? 0) + bytes);
    }
    console.log(`  plain JS ${code.length} B; largest owners (kB of minified JS):`);
    for (const [key, bytes] of [...byOwner].sort((a, b) => b[1] - a[1]).slice(0, 30))
      console.log(`  ${String(Math.round(bytes / 1024)).padStart(6)}  ${key}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const platformArg = args.indexOf("--platform");
const platforms = platformArg >= 0 ? [args[platformArg + 1]] : ["ios", "android"];
const budget = budgetBytes();
let over = false;
for (const platform of platforms) {
  const dir = mkdtempSync(join(tmpdir(), "cashu-bundle-"));
  try {
    const hbc = exportBundle(platform, dir, []).find((f) => f.endsWith(".hbc"));
    if (!hbc) throw new Error(`${platform}: expo export produced no Hermes bytecode`);
    const size = statSync(hbc).size;
    const ok = size <= budget;
    over ||= !ok;
    console.log(
      `${platform}: Hermes bytecode ${size} B, budget ${budget} B (${((100 * size) / budget).toFixed(0)}%) ${ok ? "ok" : "OVER BUDGET"}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (args.includes("--report")) report(platform);
}
if (over) {
  console.error(
    "Mobile bundle over budget: run with --report to see what is in it, then fix the import that pulled it in (subpath imports, platform files); a new budget number needs the lead (performance.md).",
  );
  process.exit(1);
}
