#!/usr/bin/env node
// Packaged smoke test of the Windows installer (the `windows` job of .github/workflows/ts.yml): install the NSIS
// installer silently per user into a temp folder, then drive the installed app's own `cashu` shim (cashU.exe in
// Node mode, resources\shim.mjs) against a fresh temp data dir, the way a user's terminal or agent does:
//
//   0. with --unpacked <win-unpacked dir>: verify-package-windows.mjs checks the install against the package it
//      came from (layout, identity, manifest, exactly the unpacked bytes plus the NSIS uninstaller);
//   1. `host status` before anything ran: not running (exit 3);
//   2. `--help`: the shim starts the installed host (named pipe, host.json) and runs a command in it;
//   3. `host status`: the host's build id is desktop-<version>-<digest of the whole install folder>;
//   4. <data dir>\bin\cashu.cmd (the launcher the host writes at every start) exists and answers `host status`;
//   5. a synthetic profile "Smoke" is created through the host's native creation methods (what the desktop
//      window's wizard calls; `cashu profiles add` needs a terminal to type the recovery phrase back): a vault
//      whose key goes to the Windows Credential Manager, checked with cmdkey (this also proves the keyring
//      binding loads under the packaged runtime: Electron in Node mode);
//   6. `host stop`, then `--profile smoke stats` through the launcher: a NEW host opens the vault, reading its key
//      back from the Credential Manager;
//   7. `host status`: the same build id as in 3 (the runtime hashes the install folder; nothing the host wrote
//      at run time may land in it);
//   8. `host stop`;
//   9. a second host on a fresh data dir under %LOCALAPPDATA% (`smoke-cashu-<random>`, synthetic, removed again):
//      the default data dir sits in the user's profile tree, where the first Windows CI run refused every data dir
//      (the owner-only DACL, packages/node-host/src/host/windowsAcl.ts), so a start there is proven too;
//      `host status`, `host stop`;
//  10. the default data dir (%LOCALAPPDATA%\cashU) was never created.
// Afterwards (also after a failure) the host is stopped, the app uninstalled, the Credential Manager items this
// run created deleted and the temp folder removed (--keep keeps the folder for a look). Right after the install
// the run registers `cashu://` for this install the way the app does at every start (the window never starts
// here: apps/desktop/src/deeplink.ts, HKCU\Software\Classes\cashu), and a passing run requires that the
// uninstall removed that key again (apps/desktop/build/windows-uninstall.nsh).
//
// Synthetic data only, never a real data dir. It runs only on Windows and only inside GitHub Actions: it
// registers cashU for the current user (HKCU) and writes a Credential Manager item, which belongs on a throwaway
// runner, not on someone's PC. The creation step speaks the host protocol through the workspace sources, so
// run it from the checkout root with the TypeScript resolver:
//
//   node --experimental-strip-types --import ./tools/node-ts/resolveTs.ts \
//     apps/desktop/scripts/smoke-windows.mjs <dir>\cashU-<version>-win-x64.exe \
//     [--unpacked build\t46\electron-builder\win-unpacked] [--keep]
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const USAGE =
  "usage: node --experimental-strip-types --import ./tools/node-ts/resolveTs.ts apps/desktop/scripts/smoke-windows.mjs <cashU-<version>-win-x64.exe> [--unpacked <win-unpacked dir>] [--keep]";
const VERIFY_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "verify-package-windows.mjs");
/** Exit code of `cashu host status` when no host runs (apps/cli/src/main.ts NOT_RUNNING_EXIT). */
const NOT_RUNNING = 3;
/** A command may start a host first (Defender scans every new file of a fresh install on its first read). */
const COMMAND_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 300_000;
const PROFILE = { name: "Smoke", slug: "smoke" };
/**
 * The name prefix of the step-9 data dir under %LOCALAPPDATA%. Not `cashu*`: the path guard refuses those
 * (packages/node-host/src/guard.ts, the owner's real data dirs), and the packaged default must stay untouched.
 */
const PROFILE_TREE_PREFIX = "smoke-cashu-";
/** The `cashu://` scheme the packaged app registers for the current user at every start. */
const SCHEME_KEY = "HKCU\\Software\\Classes\\cashu";

// --- Pure parts ------------------------------------------------------------------------------------------

/** The version in an installer file name, or null. */
function installerVersion(fileName) {
  const match = /^cashU-(\d+\.\d+\.\d+)-win-x64\.exe$/.exec(fileName);
  return match ? match[1] : null;
}

/** The build id in `cashu host status` output (English or Polish), or null. */
function statusBuild(stdout) {
  const match = /\(pid \d+, (?:build|wersja) (\S+), (?:protocol|protokół) /.exec(stdout);
  return match ? match[1] : null;
}

/** Credential Manager targets of cashU vault keys (`...vault.v1.<sha256>`) in `cmdkey /list` output. */
function vaultCredentialTargets(cmdkeyOutput) {
  const targets = new Set();
  for (const line of cmdkeyOutput.split(/\r?\n/)) {
    // "    Target: LegacyGeneric:target=<account>.cashu.vault.v1.<hash>" (the label is localized, the rest not).
    const match = /:\s*(LegacyGeneric:target=\S*vault\.v1\.[0-9a-f]{64}\S*)\s*$/.exec(line);
    if (match) targets.add(match[1]);
  }
  return [...targets].sort();
}

/** The process environment for the installed app: no CASHU_* of the caller, Node mode, the temp dirs. */
function smokeEnv(env, { dataDir, workspacesDir }) {
  const out = Object.fromEntries(Object.entries(env).filter(([key]) => !/^CASHU_/i.test(key)));
  return {
    ...out,
    ELECTRON_RUN_AS_NODE: "1",
    CASHU_DATA_DIR: dataDir,
    CASHU_WORKSPACES_DIR: workspacesDir,
  };
}

// --- Effects ---------------------------------------------------------------------------------------------

function step(text) {
  process.stdout.write(`\n==> ${text}\n`);
}
function ok(text) {
  process.stdout.write(`    ok  ${text}\n`);
}

/**
 * Runs a program with stdout / stderr in files, not pipes: the host the shim starts is detached, but a pipe
 * handle it inherited would keep this call waiting until that host exits.
 */
function runToFiles(
  ctx,
  label,
  program,
  args,
  { env, timeout = COMMAND_TIMEOUT_MS, verbatim = false },
) {
  const n = ++ctx.runs;
  const outPath = join(ctx.logs, `${String(n).padStart(2, "0")}-${label}.out`);
  const errPath = join(ctx.logs, `${String(n).padStart(2, "0")}-${label}.err`);
  const out = openSync(outPath, "w");
  const err = openSync(errPath, "w");
  let result;
  try {
    result = spawnSync(program, args, {
      env,
      stdio: ["ignore", out, err],
      timeout,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  const stdout = readFileSync(outPath, "utf8");
  const stderr = readFileSync(errPath, "utf8");
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return { status: result.status, stdout, stderr };
}

function expectStatus(label, result, expected) {
  if (result.status !== expected)
    throw new Error(
      `${label}: exit ${result.status}, expected ${expected}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`,
    );
  return result;
}

/** The installed shim: cashU.exe in Node mode running resources\shim.mjs. */
function shim(ctx, label, args, expected = 0) {
  return expectStatus(
    `cashu ${args.join(" ")}`,
    runToFiles(ctx, label, ctx.exe, [ctx.shim, ...args], { env: ctx.env }),
    expected,
  );
}

/** The launcher the host wrote, through cmd.exe (a .cmd file never runs without it). */
function launcher(ctx, label, args, expected = 0) {
  const line = `"${ctx.launcher}" ${args.join(" ")}`;
  return expectStatus(
    `cashu.cmd ${args.join(" ")}`,
    runToFiles(ctx, label, process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      env: ctx.env,
      verbatim: true,
    }),
    expected,
  );
}

function hostBuild(ctx, label, viaLauncher = false) {
  const result = viaLauncher
    ? launcher(ctx, label, ["host", "status"])
    : shim(ctx, label, ["host", "status"]);
  const build = statusBuild(result.stdout);
  if (build === null) throw new Error(`no build id in \`host status\`:\n${result.stdout}`);
  return build;
}

function cmdkeyTargets(ctx) {
  const result = runToFiles(ctx, "cmdkey-list", "cmdkey.exe", ["/list"], { env: process.env });
  if (result.status !== 0)
    throw new Error(`cmdkey /list failed (${result.status}): ${result.stderr}`);
  return vaultCredentialTargets(result.stdout);
}

/** Whether the registry key `key` exists: `reg query` exits 0 when it does, 1 when it does not. */
function registryKeyExists(ctx, label, key) {
  const result = runToFiles(ctx, label, "reg.exe", ["query", key], { env: process.env });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`reg query ${key} failed (${result.status}): ${result.stderr}`);
}

/**
 * Registers `cashu://` for the installed cashU.exe exactly as the app does at start (Electron's
 * setAsDefaultProtocolClient: a URL protocol key whose open command is `"<cashU.exe>" "%1"`).
 */
function registerScheme(ctx) {
  for (const args of [
    [SCHEME_KEY, "/ve", "/d", "URL:cashu"],
    [SCHEME_KEY, "/v", "URL Protocol", "/d", ""],
    [`${SCHEME_KEY}\\shell\\open\\command`, "/ve", "/d", `"${ctx.exe}" "%1"`],
  ])
    expectStatus(
      `reg add ${args[0]}`,
      runToFiles(ctx, "scheme-register", "reg.exe", ["add", ...args, "/f"], { env: process.env }),
      0,
    );
}

/**
 * Waits until no host runs. A host hands over (exits) on its own right after a profile was created; one that
 * still runs after 10 s is asked to stop, and one that still runs after 60 s fails the test.
 */
async function waitForNoHost(ctx) {
  const start = Date.now();
  let asked = false;
  for (;;) {
    const result = runToFiles(ctx, "status-wait", ctx.exe, [ctx.shim, "host", "status"], {
      env: ctx.env,
    });
    if (result.status === NOT_RUNNING) return;
    if (Date.now() - start > 60_000)
      throw new Error(`a host still runs after 60 s:\n${result.stdout}${result.stderr}`);
    if (!asked && Date.now() - start > 10_000) {
      asked = true;
      runToFiles(ctx, "stop-wait", ctx.exe, [ctx.shim, "host", "stop"], { env: ctx.env });
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
}

/** Creates the synthetic profile through the host's native creation methods (the desktop wizard's calls). */
async function createProfile(ctx, build) {
  let nodeHost;
  let protocol;
  try {
    nodeHost = await import("@cashu/node-host");
    protocol = await import("@cashu/host-protocol");
  } catch (error) {
    throw new Error(
      `cannot load the workspace sources (${error instanceof Error ? error.message : error}): run from the checkout root after pnpm install, with the TypeScript resolver.\n${USAGE}`,
    );
  }
  const connection = await nodeHost.connectHost({
    dataDir: ctx.dataDir,
    role: "ui",
    build,
    timeoutMs: 30_000,
  });
  try {
    if (!connection.host.features.includes(protocol.NATIVE_CREATION_FEATURE))
      throw new Error(
        `the host does not offer ${protocol.NATIVE_CREATION_FEATURE} (features: ${connection.host.features.join(", ")})`,
      );
    const prepared = protocol.nativeCreationPrepareResultSchema.parse(
      await connection.call("native.creation.prepare", {
        name: PROFILE.name,
        slug: PROFILE.slug,
        baseCurrency: "PLN",
        modules: ["budget"],
        mcpPrivacy: "strict",
      }),
    );
    if (prepared.kind !== "prepared")
      throw new Error(`native.creation.prepare refused: ${prepared.code}`);
    const committed = protocol.nativeCreationCommitResultSchema.parse(
      await connection.call("native.creation.commit", {
        operationId: prepared.operationId,
        phraseSession: prepared.phraseSession,
      }),
    );
    if (committed.kind !== "ready")
      throw new Error(`native.creation.commit ended ${JSON.stringify(committed)}`);
    if (committed.profileSlug !== PROFILE.slug)
      throw new Error(`created ${committed.profileSlug}, expected ${PROFILE.slug}`);
  } finally {
    connection.close();
  }
}

/** Every host.log under the data dir, tail first: what CI shows after a failure. */
function printHostLogs(dataDir) {
  const logs = [];
  const walk = (dir, depth) => {
    if (depth > 4 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path, depth + 1);
      else if (stat.isFile() && name.endsWith(".log")) logs.push(path);
    }
  };
  walk(dataDir, 0);
  for (const path of logs) {
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    process.stdout.write(`\n--- ${path} (last 80 lines)\n${lines.slice(-80).join("\n")}\n`);
  }
}

function cleanUp(ctx, credentialsBefore, keep) {
  step("Cleaning up");
  if (existsSync(ctx.exe)) {
    const stop = runToFiles(ctx, "cleanup-host-stop", ctx.exe, [ctx.shim, "host", "stop"], {
      env: ctx.env,
    });
    process.stdout.write(`    ..  host stop: exit ${stop.status}\n`);
    if (ctx.profileTree !== null) {
      const treeStop = runToFiles(
        ctx,
        "cleanup-profile-tree-stop",
        ctx.exe,
        [ctx.shim, "host", "stop"],
        { env: ctx.profileTree.env },
      );
      process.stdout.write(
        `    ..  host stop (${ctx.profileTree.dataDir}): exit ${treeStop.status}\n`,
      );
    }
  }
  if (ctx.profileTree !== null) {
    // Never kept: it sits in the user's profile tree, outside the temp folder. A failure here must not skip
    // the uninstall below.
    try {
      rmSync(ctx.profileTree.dataDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 1_000,
      });
      process.stdout.write(`    ..  removed ${ctx.profileTree.dataDir}\n`);
    } catch (error) {
      process.stdout.write(
        `    ..  could not remove ${ctx.profileTree.dataDir}: ${error instanceof Error ? error.message : error}\n`,
      );
    }
  }
  if (credentialsBefore !== null) {
    let after = [];
    try {
      after = cmdkeyTargets(ctx);
    } catch (error) {
      process.stdout.write(`    ..  cmdkey /list: ${error.message}\n`);
    }
    for (const target of after.filter((t) => !credentialsBefore.includes(t))) {
      const removed = runToFiles(ctx, "cmdkey-delete", "cmdkey.exe", [`/delete:${target}`], {
        env: process.env,
      });
      process.stdout.write(`    ..  Credential Manager item removed: exit ${removed.status}\n`);
    }
  }
  const uninstaller =
    existsSync(ctx.installDir) &&
    readdirSync(ctx.installDir).find((name) => /^Uninstall .*\.exe$/i.test(name));
  if (uninstaller) {
    // `_?=` runs the NSIS uninstaller in place and waits (without it, it copies itself to %TEMP% and returns).
    const removed = runToFiles(
      ctx,
      "uninstall",
      join(ctx.installDir, uninstaller),
      ["/S", `_?=${ctx.installDir}`],
      { env: process.env, timeout: INSTALL_TIMEOUT_MS, verbatim: true },
    );
    process.stdout.write(`    ..  uninstall: exit ${removed.status}\n`);
    if (ctx.schemeRegistered) {
      try {
        ctx.schemeLeft = registryKeyExists(ctx, "scheme-after-uninstall", SCHEME_KEY);
        process.stdout.write(
          `    ..  ${SCHEME_KEY} ${ctx.schemeLeft ? "still exists" : "removed by the uninstaller"}\n`,
        );
        if (ctx.schemeLeft)
          runToFiles(ctx, "scheme-delete", "reg.exe", ["delete", SCHEME_KEY, "/f"], {
            env: process.env,
          });
      } catch (error) {
        process.stdout.write(`    ..  ${error instanceof Error ? error.message : error}\n`);
      }
    }
  }
  if (keep) process.stdout.write(`    ..  kept: ${ctx.root}\n`);
  else rmSync(ctx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 1_000 });
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (process.platform !== "win32")
    throw new Error(`smoke-windows.mjs runs on Windows only (this is ${process.platform}).`);
  if (env.GITHUB_ACTIONS !== "true" || !env.RUNNER_TEMP)
    throw new Error(
      "smoke-windows.mjs runs only in GitHub Actions: it installs cashU for the current user and writes a Credential Manager item, which belongs on a throwaway runner.",
    );
  let keep = false;
  let unpacked = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--keep") keep = true;
    else if (
      argv[i] === "--unpacked" &&
      unpacked === null &&
      argv[i + 1] &&
      !argv[i + 1].startsWith("-")
    )
      unpacked = resolve(argv[++i]);
    else positional.push(argv[i]);
  }
  if (positional.length !== 1 || positional[0].startsWith("-")) throw new Error(USAGE);
  if (unpacked !== null && !existsSync(join(unpacked, "cashU.exe")))
    throw new Error(`--unpacked ${unpacked} holds no cashU.exe`);
  const installer = resolve(positional[0]);
  const version = installerVersion(basename(installer));
  if (version === null)
    throw new Error(`not a cashU-<version>-win-x64.exe installer: ${installer}`);
  if (!existsSync(installer) || !lstatSync(installer).isFile())
    throw new Error(`no installer at ${installer}`);

  // RUNNER_TEMP, not %TEMP%: the runner's %TEMP% is an 8.3 short path, and the key store refuses a data dir
  // whose real path differs from the path it is given.
  const root = realpathSync.native(mkdtempSync(join(env.RUNNER_TEMP, "cashu-smoke-")));
  if (/[\s"%]/.test(root)) throw new Error(`the temp folder ${root} has a space, quote or %`);
  const installDir = join(root, "install");
  const dataDir = join(root, "data");
  const workspacesDir = join(root, "workspaces");
  const logs = join(root, "logs");
  mkdirSync(logs);
  const ctx = {
    root,
    installDir,
    dataDir,
    logs,
    runs: 0,
    exe: join(installDir, "cashU.exe"),
    shim: join(installDir, "resources", "shim.mjs"),
    launcher: join(dataDir, "bin", "cashu.cmd"),
    env: smokeEnv(env, { dataDir, workspacesDir }),
    /** Set once this run wrote the scheme key; then the uninstall must remove it. */
    schemeRegistered: false,
    /** Whether the key outlived the uninstall (undefined: not checked). */
    schemeLeft: undefined,
    /** Step 9's data dir under %LOCALAPPDATA% and the env that points the shim at it, once created. */
    profileTree: null,
  };
  const defaultDataDir = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "cashU") : null;
  const defaultExisted = defaultDataDir !== null && existsSync(defaultDataDir);
  let credentialsBefore = null;
  try {
    credentialsBefore = cmdkeyTargets(ctx);
    // A key from before this run would make the uninstall check meaningless (the uninstaller keeps a key
    // that opens another program), and it is not this run's to touch.
    if (registryKeyExists(ctx, "scheme-before", SCHEME_KEY))
      throw new Error(`${SCHEME_KEY} exists before the install: not a fresh runner`);

    step(`Installing ${basename(installer)} silently for this user into ${installDir}`);
    // NSIS: /S silent, /D=<dir> the install folder (last, unquoted). A silent install does not start the app.
    const install = runToFiles(ctx, "install", installer, ["/S", `/D=${installDir}`], {
      env: process.env,
      timeout: INSTALL_TIMEOUT_MS,
      verbatim: true,
    });
    expectStatus("installer", install, 0);
    for (const path of [ctx.exe, ctx.shim, join(installDir, "resources", "app-identity.json")])
      if (!existsSync(path)) throw new Error(`the install lacks ${path}`);
    const identity = JSON.parse(
      readFileSync(join(installDir, "resources", "app-identity.json"), "utf8"),
    );
    if (identity.version !== version || identity.bundleId !== "io.utopiasoft.cashu")
      throw new Error(
        `app-identity.json is ${JSON.stringify(identity)}, expected ${version} / prod`,
      );
    ok(`installed ${identity.bundleId} ${identity.version}`);
    if (unpacked !== null) {
      // The installed folder is what the run-time build id hashes: exactly the package plus the uninstaller.
      const verified = runToFiles(
        ctx,
        "verify-install",
        process.execPath,
        [VERIFY_SCRIPT, installDir, "--version", version, "--installed-from", unpacked],
        { env: process.env },
      );
      expectStatus("verify-package-windows.mjs", verified, 0);
      ok(`verify-package-windows.mjs: the install is ${unpacked} plus the uninstaller`);
    }

    step("The cashu:// scheme for this install, as the app registers it at start");
    ctx.schemeRegistered = true;
    registerScheme(ctx);
    if (!registryKeyExists(ctx, "scheme-registered", SCHEME_KEY))
      throw new Error(`${SCHEME_KEY} is missing right after reg add`);
    ok(`${SCHEME_KEY} opens "${ctx.exe}" "%1"`);

    step("No host before the first command");
    shim(ctx, "status-before", ["host", "status"], NOT_RUNNING);
    ok("host status: not running (exit 3)");

    step("A command through the installed shim (starts the host)");
    const help = shim(ctx, "help", ["--help"]);
    if (help.stdout.trim() === "") throw new Error("cashu --help printed nothing");
    const first = hostBuild(ctx, "status-first");
    if (!new RegExp(`^desktop-${version.replaceAll(".", "\\.")}-[0-9a-f]{64}$`).test(first))
      throw new Error(`build id ${first} is not desktop-${version}-<digest>`);
    ok(`host runs, build ${first}`);

    step("The launcher the host wrote");
    if (!existsSync(ctx.launcher)) throw new Error(`no launcher at ${ctx.launcher}`);
    const script = readFileSync(ctx.launcher, "latin1");
    if (!script.startsWith("@echo off\r\n") || !script.includes(ctx.exe))
      throw new Error(`unexpected launcher:\n${script}`);
    const viaLauncher = hostBuild(ctx, "launcher-status", true);
    if (viaLauncher !== first) throw new Error(`the launcher reached build ${viaLauncher}`);
    ok(`${ctx.launcher} answers host status`);

    step("A synthetic profile (vault key in the Credential Manager)");
    await createProfile(ctx, first);
    const created = cmdkeyTargets(ctx).filter((t) => !credentialsBefore.includes(t));
    if (created.length === 0)
      throw new Error("no new cashU vault key in the Credential Manager after creating a profile");
    ok(
      `profile ${PROFILE.slug} created; ${created.length} new vault key item(s) in the Credential Manager`,
    );

    step("A new host opens the vault (its key read back from the Credential Manager)");
    await waitForNoHost(ctx);
    launcher(ctx, "stats", ["--profile", PROFILE.slug, "stats"]);
    const listed = launcher(ctx, "profiles", ["profiles", "list"]);
    if (!listed.stdout.includes(PROFILE.slug))
      throw new Error(`profiles list lacks ${PROFILE.slug}:\n${listed.stdout}`);
    ok(`stats and profiles list of ${PROFILE.slug} through the launcher`);

    step("The build id is stable across host starts");
    const second = hostBuild(ctx, "status-second");
    if (second !== first) throw new Error(`build id changed: ${first} -> ${second}`);
    ok(`same build ${second}`);

    step("Stopping the host");
    shim(ctx, "stop", ["host", "stop"]);
    shim(ctx, "status-after", ["host", "status"], NOT_RUNNING);
    ok("host stopped");

    step("A host on a fresh data dir under %LOCALAPPDATA% (the user's profile tree)");
    if (!env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is not set");
    const treeDir = realpathSync.native(mkdtempSync(join(env.LOCALAPPDATA, PROFILE_TREE_PREFIX)));
    ctx.profileTree = { dataDir: treeDir, env: smokeEnv(env, { dataDir: treeDir, workspacesDir }) };
    const inTree = (label, args, expected = 0) =>
      expectStatus(
        `cashu ${args.join(" ")} (${treeDir})`,
        runToFiles(ctx, label, ctx.exe, [ctx.shim, ...args], { env: ctx.profileTree.env }),
        expected,
      );
    inTree("tree-help", ["--help"]);
    const treeStatus = inTree("tree-status", ["host", "status"]);
    if (statusBuild(treeStatus.stdout) !== first)
      throw new Error(`host status on ${treeDir}:\n${treeStatus.stdout}`);
    inTree("tree-stop", ["host", "stop"]);
    inTree("tree-status-after", ["host", "status"], NOT_RUNNING);
    ok(`a host ran on ${treeDir} (build ${first}) and stopped`);

    if (defaultDataDir !== null && !defaultExisted) {
      if (existsSync(defaultDataDir))
        throw new Error(
          `the default data dir ${defaultDataDir} was created: CASHU_DATA_DIR was not honoured`,
        );
      ok(`nothing written to ${defaultDataDir}`);
    }
  } catch (error) {
    printHostLogs(dataDir);
    if (ctx.profileTree !== null) printHostLogs(ctx.profileTree.dataDir);
    throw error;
  } finally {
    try {
      cleanUp(ctx, credentialsBefore, keep);
    } catch (error) {
      process.stdout.write(`    ..  cleanup: ${error instanceof Error ? error.message : error}\n`);
    }
  }
  if (ctx.schemeLeft !== false)
    throw new Error(
      ctx.schemeLeft
        ? `the uninstall left ${SCHEME_KEY}, which opens this install's cashU.exe`
        : `could not check that the uninstall removed ${SCHEME_KEY}`,
    );
  ok(`the uninstall removed ${SCHEME_KEY}`);
  step("Windows smoke test passed");
}

const invoked = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
