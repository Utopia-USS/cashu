// Summarizes scripts/measure-ios-sim.sh output: cold start (host launch -> first data frame), the
// first launch's fixture load, the S50 scroll and mount runs.
//   usage: node summarize-bench.mjs <launches.jsonl> <results.jsonl>
import { readFileSync } from "node:fs";

const read = (f) =>
  readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const launches = read(process.argv[2]);
const results = read(process.argv[3]);
const startups = results.filter((r) => r.kind === "startup");
const q = (xs, p) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

const cold = [];
for (const l of launches) {
  const s = startups.find((r) => r.firstDataAt > l.at);
  if (!s) continue;
  if (l.first) {
    console.log(
      `first launch: launch -> first data ${s.firstDataAt - l.at} ms (includes the fixture load)`,
    );
    continue;
  }
  cold.push({ total: s.firstDataAt - l.at, js: s.firstDataAt - s.jsStartAt, open: s.openMs });
}
if (cold.length) {
  const t = cold.map((c) => c.total);
  const js = cold.map((c) => c.js);
  console.log(
    `cold start (n=${cold.length}): launch -> first data p50 ${q(t, 0.5)} ms, p95 ${q(t, 0.95)} ms, min ${Math.min(...t)} ms; ` +
      `of which JS start -> first data p50 ${q(js, 0.5)} ms; store open p50 ${Math.round(
        q(
          cold.map((c) => c.open),
          0.5,
        ),
      )} ms`,
  );
}
for (const r of results.filter((x) => x.kind === "fixture")) {
  console.log(
    `fixture: ${r.events} events, apply ${Math.round(r.applyMs)} ms, rebuild ${Math.round(r.rebuildMs)} ms, ` +
      `rebuild == apply ${r.rebuildMatches}, view hash ${r.hashAfterRebuild}`,
  );
}
for (const r of results.filter((x) => x.kind === "scroll")) {
  console.log(
    `${r.label} (${r.rows} rows): JS ${r.js.fps} fps ${r.js.droppedPct}% dropped p95 ${r.js.p95Ms} worst ${r.js.worstMs} | UI ${r.ui.fps} fps ${r.ui.droppedPct}% dropped worst ${r.ui.worstMs} @${r.hz} Hz`,
  );
}
for (const r of results.filter((x) => x.kind === "mount")) {
  console.log(`mount ${r.rows} rows: median ${r.medianMs} ms, min ${r.minMs} ms (${r.runs} runs)`);
}
