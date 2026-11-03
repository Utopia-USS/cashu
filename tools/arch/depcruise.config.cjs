// Dependency rules of the TypeScript monorepo, checked on the resolved import graph (so relative
// paths, re-exports and workspace packages are all seen). The rules mirror the layer table of the
// cashu-ts-architecture skill (tools/claude-dev/skills/cashu-ts-architecture/references/layers.md).
// Run: `pnpm arch:check` (whole graph) or tools/claude-dev/scripts/check-file.sh <file> (one file).

/** Test code and test support: exempt from the purity rule, still bound by the layer rules. */
const TEST =
  "(\\.test\\.tsx?$|\\.stories\\.tsx$|/testing/|/test-fixtures/|/e2e/|/vitest\\.config\\.ts$)";
const MODULES = "(budget|assets|loans|investments)";

/**
 * Workspace packages each package may import (besides itself). Apps may import any package.
 * A package that is not listed may import no other workspace package.
 */
const LAYERS = {
  domain: [],
  sync: ["domain"],
  // Leader-only market data over HTTP (Yahoo, stooq, NBP) behind an injected fetch.
  market: ["domain"],
  // Leader-only local/cloud classifier HTTP transports behind injected authority and fetch.
  llm: ["domain"],
  store: ["domain", "sync"],
  // React bindings over the store (useQuery, useCommand, providers) and the renderer's store client,
  // which speaks the host's store channel v2 (@cashu/host-protocol/store) through Electron main's relay.
  "store-react": ["domain", "store", "host-protocol"],
  i18n: ["domain"],
  // The local host protocol (frames, handshake, roles, store channel v2): platform free, under the
  // host (apps/host), Electron main, the shim and the renderer's store client (store-react).
  "host-protocol": ["domain"],
  ui: ["domain", "i18n"],
  "ui-logic": ["domain", "store", "store-react", "i18n"],
  api: ["domain", "store", "sync", "i18n"],
  mcp: ["domain", "store", "sync", "i18n"],
  parity: ["domain", "store", "mcp"],
  // Node-only adapters shared by apps (guard, FolderFs, node:sqlite SqlDriver); only apps import it.
  // Also the local host's platform glue: machine lock, socket server / client, connect-or-start.
  "node-host": ["domain", "store", "sync", "host-protocol"],
};

const layerRules = Object.entries(LAYERS).map(([pkg, allowed]) => ({
  name: `layer-${pkg}`,
  severity: "error",
  comment:
    `packages/${pkg} may import ${allowed.length ? allowed.map((p) => `@cashu/${p}`).join(", ") : "no other workspace package"}. ` +
    "Dependencies point down the layer table only: move the shared code down a layer, or pass it in through an interface wired at the app root.",
  from: { path: `^packages/${pkg}/` },
  to: {
    path: "^(packages|apps|tools)/",
    pathNot: `^packages/(${[pkg, ...allowed].join("|")})/`,
  },
}));

/**
 * What opens a SQLite store file: the bindings (node:sqlite, better-sqlite3, expo-sqlite, op-sqlite) and
 * node-host's driver entry (`@cashu/node-host/sqlite`).
 */
const SQLITE_OPENERS = [
  "^(node:)?sqlite$",
  "(^|/)node_modules/.*/(better-sqlite3|expo-sqlite|@op-engineering/op-sqlite)/",
  "^packages/node-host/src/(sqlite|nodeSqlite)\\.ts$",
];

/** Libraries a pure render component must not reach: navigation, app state stores, fetch caches, Electron. */
const IMPURE_LIBS =
  "(^|/node_modules/)(expo-router|@tanstack/react-router|@react-navigation/[^/]+|zustand|jotai|swr|@tanstack/react-query|electron)(/|$)";

module.exports = {
  forbidden: [
    {
      name: "domain-is-pure",
      severity: "error",
      comment:
        "packages/domain imports nothing but itself: no other package, no npm library, no node built-in. It is pure and runs unchanged on Node, Electron and Hermes. I/O, clocks and drivers come in as parameters.",
      from: { path: "^packages/domain/src/", pathNot: TEST },
      // An unresolved relative import keeps its "./x.js" spelling; tsc reports those.
      to: { pathNot: ["^packages/domain/src/", "^\\.\\.?/"] },
    },
    ...layerRules,
    {
      name: "apps-are-leaves",
      severity: "error",
      comment: "An app never imports another app. Shared code belongs in a package.",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/", pathNot: "^apps/$1/" },
    },
    {
      name: "no-relative-cross-package",
      severity: "error",
      comment:
        "Import another package by its name (@cashu/x or a declared subpath like @cashu/domain/investments), never by a relative path: the exports map is what keeps private files private.",
      from: { path: "^(packages|apps|tools)/([^/]+)/" },
      to: { dependencyTypes: ["local"], path: "^(packages|apps|tools)/", pathNot: "^$1/$2/" },
    },
    {
      name: "node-host-is-for-apps",
      severity: "error",
      comment:
        "@cashu/node-host holds Node-only adapters (file system, node:sqlite, path guards) for the hosts in apps/. Only apps import it; a package takes the platform piece through its interface (SqlDriver, FolderFs) wired at the app root.",
      from: { path: "^(packages|tools)/", pathNot: "^packages/node-host/" },
      to: { path: "^packages/node-host/" },
    },
    {
      name: "only-host-opens-stores",
      severity: "error",
      comment:
        'Only the local host (apps/host, one per data dir) and the Expo app (apps/mobile, its engine in process) open SQLite stores. Every other app is a client of the host over its socket (@cashu/node-host connectHost / connectOrStart): a second process opening a store would fork this device\'s stream (layers.md, "Which process runs what"). Move the store access into a host service and call it over the protocol.',
      from: {
        path: "^apps/",
        pathNot: [TEST, "^apps/(host|mobile)/"],
      },
      to: { path: SQLITE_OPENERS },
    },
    {
      name: "module-internals",
      severity: "error",
      comment:
        "Modules (budget, assets, loans, investments) never import another module's internals. Use that module's public index.ts, or move the shared concept to core.",
      from: { path: `/src/${MODULES}/` },
      to: { path: `/src/${MODULES}/`, pathNot: [`/src/$1/`, `/src/${MODULES}/index\\.tsx?$`] },
    },
    {
      name: "core-imports-no-module",
      severity: "error",
      comment:
        "core is always on and never depends on an optional module; the module registers itself with core instead.",
      from: { path: "/src/core/" },
      to: { path: `/src/${MODULES}/` },
    },
    {
      name: "view-is-pure",
      severity: "error",
      comment:
        "A View renders props. It never imports the store, its React bindings (useQuery, useCommand), sync, ui-logic feature hooks, commands, navigation, app-state stores or network clients: the screen hook does that and passes the result in. Type-only imports are fine.",
      from: { path: "View(\\.(web|native|ios|android))?\\.tsx$" },
      to: {
        dependencyTypesNot: ["type-only"],
        path: [
          `^packages/(store|store-react|sync|ui-logic|node-host)/`,
          "(^|/)commands(\\.tsx?|/|$)",
          IMPURE_LIBS,
        ],
      },
    },
    {
      name: "ui-is-pure",
      severity: "error",
      comment:
        "packages/ui components get data through props. No store, store bindings, sync, ui-logic, navigation, app-state stores or network clients.",
      from: { path: "^packages/ui/src/" },
      to: {
        dependencyTypesNot: ["type-only"],
        path: [`^packages/(store|store-react|sync|ui-logic)/`, IMPURE_LIBS],
      },
    },
    {
      name: "no-test-code-in-prod",
      severity: "error",
      comment: "Production code never imports tests, fixtures or test helpers.",
      from: { pathNot: TEST },
      to: { path: TEST },
    },
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Import cycles make load order matter and hide layering mistakes. Extract the shared part into its own file.",
      from: {},
      to: { circular: true, dependencyTypesNot: ["type-only"] },
    },
  ],
  options: {
    doNotFollow: { path: "(^|/)node_modules/" },
    // node_modules is not followed (above) but must not be excluded: an excluded module drops the
    // edges to it, so rules naming npm packages (IMPURE_LIBS, SQLITE_OPENERS) would never fire.
    exclude: { path: "(^|/)(dist|\\.turbo|coverage)/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "types", "default"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".cts"],
      mainFields: ["module", "main", "types"],
    },
    moduleSystems: ["es6", "cjs"],
  },
};
