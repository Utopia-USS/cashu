// A stand-in for `cashu serve --parent-pipe` (tests only): reads the token from the first line of
// stdin, answers GET /api/health (200 with that token, 401 without), and exits when stdin closes
// (core/parent_pipe.py).
//   FAKE_MODE=ok (default) | exit-early | hang | stubborn (ignores stdin EOF and SIGTERM) | leaky
//   (prints the token it was given, to prove the shell redacts it) | leaky-split (prints the token and
//   a request log line, each cut in two writes as Python's unbuffered print does) | foreign (holds
//   another token)
import { createServer } from "node:http";

const mode = process.env.FAKE_MODE || "ok";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
if (!args.includes("--parent-pipe")) {
  process.stderr.write("fake-serve: --parent-pipe missing\n");
  process.exit(2);
}

if (mode === "exit-early") {
  process.stderr.write("Traceback: boom\n");
  process.exit(3);
}

let buffered = "";
let token = null;
process.stdin.on("data", (chunk) => {
  if (token !== null) return;
  buffered += chunk.toString();
  const newline = buffered.indexOf("\n");
  if (newline >= 0) {
    token = buffered.slice(0, newline).trim();
    start();
  }
});
process.stdin.on("end", () => {
  if (mode !== "stubborn") process.exit(0);
});
if (mode === "stubborn") process.on("SIGTERM", () => {});

function start() {
  if (mode === "hang") return;
  const held = mode === "foreign" ? "someoneElsesToken_0123456789abcdefghij" : token;
  const server = createServer((req, res) => {
    const ok = req.headers["x-cashu-token"] === held;
    if (req.url === "/api/health") {
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(ok ? '{"status":"ok"}' : '{"detail":"Missing or invalid API token"}');
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html></html>");
  });
  server.once("error", (error) => {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`Dashboard: http://127.0.0.1:${port}/ (API token from the parent)\n`);
    if (mode === "leaky") process.stdout.write(`debug: token ${token}\n`);
    process.stderr.write("INFO:     Application startup complete.\n");
    process.stderr.write(
      'INFO:     127.0.0.1:50000 - "GET /api/p/demo/secret-path HTTP/1.1" 200 OK\n',
    );
    if (mode === "leaky-split") {
      // Two writes per line with a pause between: the parent reads each line in two chunks.
      const half = token.length >> 1;
      process.stdout.write(`debug: token ${token.slice(0, half)}`);
      process.stderr.write('INFO:     127.0.0.1:50001 - "GET /api/p/demo/split-');
      setTimeout(() => {
        process.stdout.write(`${token.slice(half)}\nsplit done\n`);
        process.stderr.write('secret-path HTTP/1.1" 200 OK\nsplit done\n');
      }, 50);
    }
  });
}
