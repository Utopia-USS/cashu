// Bundles the side-effect-free Electron entry (src/entry.ts) into dist/main.js. It dispatches the
// exact notification helper mode before importing the ordinary main process. Main imports workspace packages
// (@cashu/node-host for connect-or-start, @cashu/host-protocol for the frames) as TypeScript sources
// (their exports maps point at src/*.ts with NodeNext `.js` specifiers), which plain tsc output cannot
// load at run time; rolldown resolves and transpiles them into one ES module. node:* and electron stay
// external. The sandboxed preload stays a tsc-built CommonJS file (tsconfig.build.json), built after this.
//   node scripts/build-main.mjs   (part of `pnpm --filter @cashu/desktop build`)
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(app, "dist");
mkdirSync(dist, { recursive: true });

// A clean dist (runs before the preload's tsc build): nothing stale may sit next to main. The e2e
// spec tree (dist/e2e-run, written by the Playwright config) is left alone.
for (const entry of readdirSync(dist, { withFileTypes: true })) {
  if (entry.name !== "e2e-run") rmSync(join(dist, entry.name), { recursive: true, force: true });
}

await build({
  input: join(app, "src", "entry.ts"),
  platform: "node",
  external: [/^node:/, /^electron(\/.*)?$/],
  resolve: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
  output: {
    dir: dist,
    entryFileNames: "main.js",
    chunkFileNames: "[name]-[hash].js",
    format: "esm",
    sourcemap: true,
  },
  logLevel: "warn",
});
