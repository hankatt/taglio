#if DEBUG && canImport(UIKit)
import UIKit

/// What a note from the app holds. The same shape as a note from a web page,
/// with the app, the device and the screen added.
struct Payload: Encodable {
    struct App: Encodable { let bundleId: String?; let name: String?; let version: String?; let build: String? }
    struct Device: Encodable { let model: String; let system: String; let scale: Double; let width: Int; let height: Int }
    struct Rect: Encodable { let x: Int; let y: Int; let width: Int; let height: Int }

    var id = ""
    let note: String
    let platform = "ios"
    let screen: String
    let app: App
    let device: Device
    let rect: Rect
    let elements: [Element]
    let png: String?
}

/// Notes travel as files in the app's own container, so the app never opens
/// a network connection and iOS never asks for permission. `taglio watch`
/// on the Mac collects them: from a simulator straight from disk, and from
/// an iPhone through Xcode's connection to it (`xcrun devicectl`), over the
/// cable or Wi-Fi. It writes each note's status and its own heartbeat back
/// the same way.
///
///     Library/Application Support/taglio/
///         outbox/<id>.json   notes waiting for the Mac (written here)
///         status/<id>.json   where each note is (written by the Mac)
///         watch.json         the project and the time, while a watch runs
struct Mailbox {
    struct Status: Decodable { let state: String; let message: String? }

    let root: URL
    var outbox: URL { root.appendingPathComponent("outbox") }
    var statuses: URL { root.appendingPathComponent("status") }

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        root = support.appendingPathComponent("taglio")
        for dir in [outbox, statuses] { try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
    }

    /// The project of the watch that wrote here in the last 30 seconds.
    var project: String? {
        struct Watch: Decodable { let project: String; let at: Double }
        guard let data = try? Data(contentsOf: root.appendingPathComponent("watch.json")),
              let watch = try? JSONDecoder().decode(Watch.self, from: data),
              Date().timeIntervalSince1970 * 1000 - watch.at < 30_000 else { return nil }
        return watch.project
    }

    /// Saves a note for the Mac to collect and returns its id. The id is the
    /// time, in the same form `taglio watch` uses for notes from web pages.
    func send(_ payload: Payload) throws -> String {
        var payload = payload
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        payload.id = formatter.string(from: Date()).replacingOccurrences(of: ":", with: "-").replacingOccurrences(of: ".", with: "-")
        // Written whole, then moved into place, so the Mac never copies half a note.
        try JSONEncoder().encode(payload).write(to: outbox.appendingPathComponent("\(payload.id).json"), options: .atomic)
        return payload.id
    }

    func status(_ id: String) -> Status? {
        guard let data = try? Data(contentsOf: statuses.appendingPathComponent("\(id).json")) else { return nil }
        return try? JSONDecoder().decode(Status.self, from: data)
    }

    /// Removes a note and its status once it's done, or failed.
    func finish(_ id: String) {
        try? FileManager.default.removeItem(at: outbox.appendingPathComponent("\(id).json"))
        try? FileManager.default.removeItem(at: statuses.appendingPathComponent("\(id).json"))
    }

    /// Removes notes the Mac finished while the app wasn't running.
    func tidy() {
        for file in (try? FileManager.default.contentsOfDirectory(atPath: statuses.path)) ?? [] where file.hasSuffix(".json") {
            let id = String(file.dropLast(5))
            if let state = status(id)?.state, state == "done" || state == "failed" { finish(id) }
        }
    }
}
#endif
