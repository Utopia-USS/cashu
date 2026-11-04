// Real POSIX terminal descriptors: a pseudo-terminal from `script`, sized with stty, with stdout
// redirected to a file. No cashU data or app code is loaded. The expected width is the one Rich (the
// retired Python CLI) read in the same setup. macOS `script` syntax; elsewhere the fake terminals of the
// shim tests cover the size logic.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "./testing/dirs.js";

afterEach(removeTempDirs);

const TERMINAL = new URL("./terminal.ts", import.meta.url).href;
const PROBE = `import { terminalSize } from ${JSON.stringify(TERMINAL)};
import { fstatSync } from "node:fs";
const size = terminalSize();
setImmediate(() => console.log(JSON.stringify({ size, stdinOpen: !!fstatSync(0) })));
`;

it.skipIf(process.platform !== "darwin").each([0, 2])(
  "reads the redirected width from terminal fd %i without closing stdin",
  (fd) => {
    const dir = tempDir();
    const probe = join(dir, "probe.mjs");
    const out = join(dir, "out.json");
    writeFileSync(probe, PROBE);
    // fd 0: stdin is the terminal, stderr goes to a file; fd 2: stderr is the terminal, stdin is empty.
    const redirect = fd === 0 ? `>"${out}" 2>"${join(dir, "err")}"` : `</dev/null >"${out}"`;
    const node = `"${process.execPath}" --no-warnings --experimental-strip-types "${probe}"`;
    const run = spawnSync(
      "script",
      ["-q", "/dev/null", "sh", "-c", `stty cols 57 rows 24 && ${node} ${redirect}`],
      { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", env: { PATH: process.env.PATH } },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ size: [57, 24], stdinOpen: true });
  },
);
