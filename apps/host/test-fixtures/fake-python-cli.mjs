#!/usr/bin/env node
// A stand-in for the Python `cashu` CLI (tests only; CI has no Python): what the host delegates to and
// what its MCP sessions start. Synthetic, no data.
//   mcp --profile <slug>   a tiny MCP server over stdio (initialize, tools/list, tools/call echo / slow /
//                          exit; profile "missing" exits 1 like the Python CLI's unknown profile)
//   exit <n>               exits with n;   signal: dies of SIGTERM;   stdin: echoes stdin to stdout
//   anything else          prints one JSON line: argv, cwd, the CASHU_* env, which fds are terminals
import { createInterface } from "node:readline";
import { isatty } from "node:tty";

const argv = process.argv.slice(2);

if (argv[0] === "mcp") {
  const profile = argv[argv.indexOf("--profile") + 1];
  if (profile === "missing") {
    process.stderr.write("No profile 'missing'. Profiles: demo.\n");
    process.exit(1);
  }
  process.stderr.write(`fake mcp: serving ${profile}\n`);
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const tools = [
    { name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } },
    { name: "slow", description: "Never answers", inputSchema: { type: "object" } },
  ];
  createInterface({ input: process.stdin }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: `cashu-${profile}`, version: "0.0.0" },
          instructions: "fake",
        },
      });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    } else if (msg.method === "tools/call") {
      const name = msg.params?.name;
      if (name === "slow") return;
      if (name === "exit") process.exit(0);
      const env = {
        CASHU_DATA_DIR: process.env.CASHU_DATA_DIR,
        CASHU_MARK: process.env.CASHU_MARK,
      };
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [
            { type: "text", text: JSON.stringify({ cwd: process.cwd(), env, pid: process.pid }) },
          ],
        },
      });
    } else if ("id" in msg && msg.method !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
    }
  });
} else if (argv[0] === "exit") {
  process.exit(Number(argv[1]));
} else if (argv[0] === "signal") {
  process.kill(process.pid, "SIGTERM");
} else if (argv[0] === "stdin") {
  process.stdin.pipe(process.stdout);
} else {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith("CASHU_")),
  );
  process.stdout.write(
    `${JSON.stringify({ argv, cwd: process.cwd(), env, tty: [isatty(0), isatty(1), isatty(2)] })}\n`,
  );
  process.stderr.write("fake cli: done\n");
}
