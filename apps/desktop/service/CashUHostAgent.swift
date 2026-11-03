// S47 compiles this fixed agent executable at Contents/MacOS/cashu-next-host-agent.
// It launches the bundled host once; the host's lock and idle policy own the lifecycle.
import Darwin
import Foundation

let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
let contents = executable.deletingLastPathComponent().deletingLastPathComponent()
guard contents.lastPathComponent == "Contents",
      contents.deletingLastPathComponent().pathExtension == "app" else { exit(78) }

let electron = contents.appendingPathComponent("MacOS/cashU").path
let host = contents.appendingPathComponent("Resources/host.mjs").path
let home = FileManager.default.homeDirectoryForCurrentUser.path
let dataDir = URL(fileURLWithPath: home)
    .appendingPathComponent("Library/Application Support/cashU").path
guard FileManager.default.isExecutableFile(atPath: electron),
      FileManager.default.fileExists(atPath: host) else { exit(78) }

var environment = ProcessInfo.processInfo.environment
environment["ELECTRON_RUN_AS_NODE"] = "1"
environment.removeValue(forKey: "CASHU_DATA_DIR")
let args = [electron, host, "run", "--data-dir", dataDir, "--bundle", host]
let cArgs = args.map { strdup($0) } + [nil]
let cEnv = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
execve(electron, cArgs, cEnv)
exit(71)
