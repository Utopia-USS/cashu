// Bundles the store process (src/storeProcess/main.ts, an Electron utility process) into
// dist/store-process.mjs. It imports the workspace packages as TypeScript sources (their exports
// maps point at src/*.ts with NodeNext `.js` specifiers), which plain tsc output cannot load at run
// time; rolldown resolves and transpiles them into one ES module. node:* and electron stay external.
//   node scripts/build-store.mjs   (part of `pnpm --filter @cashu/desktop build`)
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  input: join(app, "src", "storeProcess", "main.ts"),
  platform: "node",
  external: [/^node:/, "electron"],
  resolve: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
  output: { file: join(app, "dist", "store-process.mjs"), format: "esm", sourcemap: true },
  logLevel: "warn",
});
