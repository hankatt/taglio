#if DEBUG && canImport(UIKit)
import UIKit

/// Makes sure the app's accessibility elements exist when taglio reads them.
///
/// SwiftUI builds its accessibility tree only while the system's app
/// accessibility setting is on, which VoiceOver or Accessibility Inspector
/// turn on. The simulator has it on; an iPhone usually doesn't. So on an
/// iPhone, taglio turns it on just while it reads the elements, for up to
/// two seconds, and then off again. This uses private functions from
/// libAccessibility, which is why it's in debug builds only.
///
/// Before turning it on, taglio leaves a marker file. If the app is stopped
/// before taglio turns the setting off, the next launch finds the marker and
/// turns it off then. Without the marker taglio never turns it off, so it
/// never switches off VoiceOver or anything else that turned it on.
enum AppAccessibility {
    private static let library = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW)

    private static var marker: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("taglio/accessibility-turned-on")
    }

    private static func function<T>(_ name: String, as type: T.Type) -> T? {
        library.flatMap { dlsym($0, name) }.map { unsafeBitCast($0, to: type) }
    }

    /// Whether the setting is on. Reads as on when the function is missing,
    /// so taglio then leaves the setting alone.
    static var isOn: Bool {
        (function("_AXSApplicationAccessibilityEnabled", as: (@convention(c) () -> Int32).self)?() ?? 1) != 0
    }

    private static func set(_ on: Bool) {
        function("_AXSApplicationAccessibilitySetEnabled", as: (@convention(c) (Int32) -> Void).self)?(on ? 1 : 0)
    }

    /// At launch: turns the setting off if taglio turned it on last time and
    /// the app stopped before it could turn it off.
    static func tidy() {
        guard FileManager.default.fileExists(atPath: marker.path) else { return }
        if isOn {
            set(false)
            print("taglio: turned the app accessibility setting back off, which the last run left on. It's \(isOn ? "still on" : "off") now.")
        } else {
            print("taglio: the last run left the app accessibility setting on, and it's off already.")
        }
        try? FileManager.default.removeItem(at: marker)
    }

    /// Reads the elements, with the setting on for as short a time as it takes.
    @MainActor
    static func read(_ collect: () -> [Element]) async -> [Element] {
        if isOn { return collect() }
        try? FileManager.default.createDirectory(at: marker.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: marker.path, contents: nil)
        set(true)
        let started = Date()
        // The app builds the tree once it hears the setting changed. Read
        // every tenth of a second until two reads agree.
        var found: [Element] = []
        for _ in 0..<20 {
            try? await Task.sleep(nanoseconds: 100_000_000)
            let next = collect()
            if !next.isEmpty && next.count == found.count { break }
            found = next
        }
        // For testing the launch clean-up: TAGLIO_TEST_LEAVE_ON=1 leaves the
        // setting on, as if the app were stopped right here.
        if ProcessInfo.processInfo.environment["TAGLIO_TEST_LEAVE_ON"] == "1" {
            print("taglio: test, leaving app accessibility on (\(isOn ? "on" : "off")).")
            return found
        }
        set(false)
        try? FileManager.default.removeItem(at: marker)
        print("taglio: read \(found.count) elements with app accessibility on for \(Int(Date().timeIntervalSince(started) * 1000)) ms. It's \(isOn ? "still on" : "off") now.")
        return found
    }
}
#endif
