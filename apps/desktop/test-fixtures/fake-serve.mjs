// A stand-in for `cashu serve` (tests only): prints the same one-time Dashboard line and the
// uvicorn startup lines, answers GET / on 127.0.0.1:<port>.
//   FAKE_MODE=ok (default) | exit-early | busy | hang | stubborn (ignores SIGINT)
import { createServer } from "node:http";

const mode = process.env.FAKE_MODE || "ok";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const token = "fakeToken_0123456789abcdefghijklmnop";

if (mode === "exit-early") {
  process.stderr.write("Traceback: boom\n");
  process.exit(3);
}
if (mode === "busy") {
  process.stderr.write(
    `ERROR: [Errno 48] error while attempting to bind on address ('127.0.0.1', ${port}): address already in use\n`,
  );
  process.exit(1);
}
if (mode === "hang") setInterval(() => {}, 1000);

if (mode !== "hang") {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html></html>");
  });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`Dashboard: http://127.0.0.1:${port}/#token=${token}\n`);
    process.stdout.write(`Data dir: ${process.env.CASHU_DATA_DIR} (API token: api-token)\n`);
    process.stderr.write("INFO:     Started server process [1]\n");
    process.stderr.write("INFO:     Application startup complete.\n");
    process.stderr.write(
      `INFO:     Uvicorn running on http://127.0.0.1:${port} (Press CTRL+C to quit)\n`,
    );
    process.stderr.write(
      'INFO:     127.0.0.1:50000 - "GET /api/p/demo/secret-path HTTP/1.1" 200 OK\n',
    );
  });
  const stop = () => server.close(() => process.exit(0));
  if (mode === "stubborn") {
    process.on("SIGINT", () => {});
  } else {
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
}
