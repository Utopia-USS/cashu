// Real POSIX terminal descriptors, with stdout redirected. No cashU data or app code is loaded.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const PYTHON = fileURLToPath(new URL("../../../.venv/bin/python", import.meta.url));
const TERMINAL = new URL("./terminal.ts", import.meta.url).href;
it.skipIf(process.platform === "win32" || !existsSync(PYTHON)).each([0, 2])(
  "matches Rich's redirected width using terminal fd %i without closing stdin",
  (fd) => {
    const code = `import os, pty, fcntl, termios, struct, subprocess, json, sys
from rich.console import Console
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 57, 0, 0))
os.dup2(slave, int(sys.argv[1]))
expected = Console(_environ={}).width
script = sys.argv[3]
result = subprocess.run([sys.argv[2], '--no-warnings', '--experimental-strip-types', '--input-type=module', '-e', script], stdin=slave if int(sys.argv[1]) == 0 else subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=slave if int(sys.argv[1]) == 2 else subprocess.PIPE, text=True)
print(json.dumps({'expected':expected, 'code':result.returncode, 'stdout':result.stdout, 'stderr':result.stderr}))
os.close(master)
os.close(slave)
`;
    const script = `import { terminalSize } from ${JSON.stringify(TERMINAL)}; import { fstatSync } from 'node:fs'; const size=terminalSize(); setImmediate(()=>console.log(JSON.stringify({size,stdinOpen:!!fstatSync(0)})));`;
    const run = spawnSync(PYTHON, ["-c", code, String(fd), process.execPath, script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, CASHU_TESTING: "1" },
    });
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as {
      expected: number;
      code: number;
      stdout: string;
      stderr: string | null;
    };
    expect(result.code, result.stderr ?? "").toBe(0);
    expect(result.expected).toBe(57);
    expect(JSON.parse(result.stdout)).toEqual({ size: [57, 24], stdinOpen: true });
  },
);
