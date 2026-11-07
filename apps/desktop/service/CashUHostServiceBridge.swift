// S47 compiles this into an in-process Electron main binding. Do not execute it as a separate
// command: SMAppService.agent uses the calling app's Bundle.main for plist lookup and identity.
import Foundation
import ServiceManagement
import Dispatch

@available(macOS 13.0, *)
@objc public final class CashUHostServiceBridge: NSObject {
    private static let plist = "io.utopiasoft.cashu.host.plist"
    private static let label = "io.utopiasoft.cashu.host"
    private static let bundleID = "io.utopiasoft.cashu"

    private var agent: SMAppService { SMAppService.agent(plistName: Self.plist) }

    // The native binding must expose these values to trusted Electron main only.
    @objc public func identity() -> [String: String] {
        ["bundleId": Bundle.main.bundleIdentifier ?? "",
         "bundlePath": Bundle.main.bundlePath]
    }

    private func requireOwnApp() throws {
        guard Bundle.main.bundleIdentifier == Self.bundleID,
              Bundle.main.bundleURL.pathExtension == "app" else {
            throw NSError(domain: "CashUHostService", code: 1)
        }
    }

    @objc public func status() throws -> String {
        try requireOwnApp()
        switch agent.status {
        case .notRegistered: return "notRegistered"
        case .enabled: return "enabled"
        case .requiresApproval: return "requiresApproval"
        case .notFound: return "notFound"
        @unknown default: return "notFound"
        }
    }

    @objc public func register() throws {
        try requireOwnApp()
        try agent.register()
    }

    @objc public func unregister() throws {
        try requireOwnApp()
        try agent.unregister()
    }

    // No renderer-controlled label or path. Only the enabled, exact agent may be kicked.
    @objc public func activate() -> Bool {
        do {
            try requireOwnApp()
            guard agent.status == .enabled else { return false }
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            task.arguments = ["kickstart", "gui/\(getuid())/\(Self.label)"]
            let done = DispatchSemaphore(value: 0)
            task.terminationHandler = { _ in done.signal() }
            try task.run()
            if done.wait(timeout: .now() + .seconds(3)) == .timedOut {
                task.terminate()
                return false
            }
            return task.terminationStatus == 0
        } catch {
            return false
        }
    }
}
