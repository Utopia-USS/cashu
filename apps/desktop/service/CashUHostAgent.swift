// S47 compiles this fixed agent executable at Contents/MacOS/cashu-next-host-agent.
// It launches the bundled host once; the host's lock and idle policy own the lifecycle.
import Darwin
import Foundation

let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
let contents = executable.deletingLastPathComponent().deletingLastPathComponent()
let bundleURL = contents.deletingLastPathComponent()
let bundle = Bundle(url: bundleURL)
guard contents.lastPathComponent == "Contents",
      bundleURL.pathExtension == "app",
      executable.lastPathComponent == "cashu-next-host-agent",
      bundle?.bundleIdentifier == "io.utopiasoft.cashu.next",
      bundle?.object(forInfoDictionaryKey: "CFBundleExecutable") as? String == "cashU",
      let version = bundle?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
      !version.isEmpty else { exit(78) }

let electron = contents.appendingPathComponent("MacOS/cashU").path
let host = contents.appendingPathComponent("Resources/host.mjs").path
let home = FileManager.default.homeDirectoryForCurrentUser.path
let dataDir = URL(fileURLWithPath: home)
    .appendingPathComponent("Library/Application Support/cashU").resolvingSymlinksInPath().path
guard FileManager.default.isExecutableFile(atPath: electron),
      FileManager.default.fileExists(atPath: host) else { exit(78) }

var environment = ProcessInfo.processInfo.environment
for key in environment.keys {
    if key.hasPrefix("PYTHON") || key.hasPrefix("_PYI_") || key.hasPrefix("PYINSTALLER_") ||
       key.hasPrefix("DYLD_") || key.hasPrefix("LD_") || key.hasPrefix("CASHU_DESKTOP_") ||
       key == "CASHU_PYTHON_CLI" {
        environment.removeValue(forKey: key)
    }
}
environment["ELECTRON_RUN_AS_NODE"] = "1"
environment["CASHU_DATA_DIR"] = dataDir
environment["CASHU_BUILD"] = "desktop-\(version)"
let args = [electron, host, "run", "--data-dir", dataDir, "--bundle", host]
let cArgs = args.map { strdup($0) } + [nil]
let cEnv = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
execve(electron, cArgs, cEnv)
exit(71)
