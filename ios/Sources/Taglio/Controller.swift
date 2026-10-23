#if DEBUG && canImport(UIKit)
import SwiftUI
import UIKit

/// Listens for the triggers, freezes the screen and shows the slice in a
/// window of its own above the app, so the app's own views never change.
@MainActor
final class Controller {
    static let shared = Controller()

    private let mailbox = Mailbox()
    private var overlay: UIWindow?
    private var toast: Toast?
    private var started = false

    func start() {
        guard !started else { return }
        started = true
        AppAccessibility.tidy()
        mailbox.tidy()

        // Holding three fingers on the screen, in any of the app's windows.
        // A screenshot would be the obvious trigger, but iOS always opens its
        // own screenshot preview on top, which has to be closed first.
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
            scene.windows.forEach(Press.add)
        }
        NotificationCenter.default.addObserver(forName: UIWindow.didBecomeKeyNotification, object: nil, queue: .main) { note in
            guard let window = note.object as? UIWindow else { return }
            Task { @MainActor in Press.add(to: window) }
        }
        Shake.install()
        // Opens the slice from the Mac, for testing:
        // `xcrun simctl spawn booted notifyutil -p dev.taglio.slice`, or on an
        // iPhone, `xcrun devicectl device notification post --device <id> --name dev.taglio.slice`.
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), nil, { _, _, _, _, _ in
            Task { @MainActor in Controller.shared.trigger() }
        }, "dev.taglio.slice" as CFString, nil, .deliverImmediately)
        print("taglio: hold three fingers on the screen, or shake, to slice. Notes go to `taglio watch`, or /taglio in Claude Code, on your Mac.")
    }

    /// Shows the pill at the top, once the app has a window to show it in.
    @discardableResult
    private func showToast(_ title: String, detail: String, hideAfter seconds: Double? = nil) -> Bool {
        guard let scene, !scene.windows.isEmpty else { return false }
        let toast = self.toast ?? Toast(scene: scene)
        self.toast = toast
        toast.show(title, detail: detail, hideAfter: seconds)
        return true
    }

    private var scene: UIWindowScene? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    }

    func trigger() {
        guard started, overlay == nil, let scene else { return }
        guard let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first(where: { !$0.isHidden }) else { return }
        // The picture and the elements come first, before taglio shows
        // anything, so none of its own views end up in the note.
        let capture = Capture.take(window)
        let model = SliceModel(capture: capture, mailbox: mailbox)
        model.onClose = { [weak self] id in self?.close(sent: id) }

        let host = UIHostingController(rootView: SliceView(model: model))
        host.view.backgroundColor = .black
        let overlay = UIWindow(windowScene: scene)
        overlay.windowLevel = .alert + 1
        overlay.rootViewController = host
        overlay.makeKeyAndVisible()
        self.overlay = overlay
        model.automateIfAsked()
    }

    private func close(sent id: String?) {
        overlay?.isHidden = true
        overlay = nil
        scene?.windows.first { $0.windowLevel == .normal }?.makeKey()
        guard let id else { return }
        if mailbox.project != nil { showToast("Sent", detail: "Waiting for Claude") }
        else { showToast("Saved", detail: "It goes to Claude when you run /taglio", hideAfter: 5) }
        follow(id)
    }

    // Checks where the note is every second, for up to an hour, and shows
    // each change at the top of the screen.
    private func follow(_ id: String) {
        Task {
            var last = "queued"
            for _ in 0..<3600 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let status = mailbox.status(id), status.state != last else { continue }
                last = status.state
                switch status.state {
                case "received": showToast("Sent", detail: "Waiting for Claude")
                case "processing": showToast("Processing", detail: "Claude is on it")
                case "done": showToast("Done", detail: status.message ?? "", hideAfter: 6)
                case "failed": showToast("Failed", detail: status.message ?? "", hideAfter: 8)
                default: break
                }
                if status.state == "done" || status.state == "failed" {
                    mailbox.finish(id)
                    return
                }
            }
        }
    }
}

/// A long press with three fingers, added to each of the app's own windows.
/// It doesn't delay the app's touches, so taps and scrolls work as usual.
/// It fires after 0.35 seconds, before the app's own long presses (0.5 by
/// default), and once it fires, UIKit stops those from firing too, so
/// holding three fingers on a card doesn't also select it.
@MainActor
final class Press: NSObject {
    static let shared = Press()

    static func add(to window: UIWindow) {
        // taglio's own windows sit above the app's, at alert level.
        guard window.windowLevel < .alert, !(window.gestureRecognizers ?? []).contains(where: { $0.name == "taglio" }) else { return }
        let press = UILongPressGestureRecognizer(target: shared, action: #selector(pressed(_:)))
        press.name = "taglio"
        press.numberOfTouchesRequired = 3
        press.minimumPressDuration = 0.35
        // Once it fires, the views under the fingers get their touches
        // cancelled, so a button or card doesn't react when they lift.
        press.cancelsTouchesInView = true
        press.delaysTouchesBegan = false
        press.delaysTouchesEnded = false
        window.addGestureRecognizer(press)
    }

    @objc private func pressed(_ press: UILongPressGestureRecognizer) {
        if press.state == .began { Controller.shared.trigger() }
    }
}

/// Catches the shake gesture by wrapping UIWindow's motionEnded, which
/// receives shakes when nothing else handles them.
enum Shake {
    static func install() {
        let original = #selector(UIResponder.motionEnded(_:with:))
        let replacement = #selector(UIWindow.taglio_motionEnded(_:with:))
        guard let originalMethod = class_getInstanceMethod(UIWindow.self, original),
              let replacementMethod = class_getInstanceMethod(UIWindow.self, replacement) else { return }
        if class_addMethod(UIWindow.self, original, method_getImplementation(replacementMethod), method_getTypeEncoding(replacementMethod)) {
            class_replaceMethod(UIWindow.self, replacement, method_getImplementation(originalMethod), method_getTypeEncoding(originalMethod))
        } else {
            method_exchangeImplementations(originalMethod, replacementMethod)
        }
    }
}

extension UIWindow {
    @objc func taglio_motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        if motion == .motionShake {
            Task { @MainActor in Controller.shared.trigger() }
        }
        taglio_motionEnded(motion, with: event)
    }
}

/// A small pill at the top of the screen showing where the last note is.
/// Its window takes no touches, so the app works as usual under it.
@MainActor
final class Toast {
    private let window: UIWindow
    private let model = ToastModel()
    private var hide: Task<Void, Never>?

    init(scene: UIWindowScene) {
        window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 2
        window.isUserInteractionEnabled = false
        let host = UIHostingController(rootView: ToastView(model: model))
        host.view.backgroundColor = .clear
        window.rootViewController = host
        window.backgroundColor = .clear
    }

    func show(_ title: String, detail: String, hideAfter seconds: Double? = nil) {
        window.isHidden = false
        withAnimation(.smooth(duration: 0.3)) { model.text = (title, detail) }
        hide?.cancel()
        guard let seconds else { return }
        hide = Task {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            withAnimation(.smooth(duration: 0.3)) { model.text = nil }
            try? await Task.sleep(nanoseconds: 400_000_000)
            if !Task.isCancelled { window.isHidden = true }
        }
    }
}

final class ToastModel: ObservableObject {
    @Published var text: (String, String)?
}

struct ToastView: View {
    @ObservedObject var model: ToastModel

    var body: some View {
        VStack {
            if case let (title, detail)? = model.text {
                HStack(spacing: 8) {
                    Circle().fill(title == "Done" ? Color.green : title == "Failed" ? Color.red : Color.blue).frame(width: 8, height: 8)
                    Text(title).fontWeight(.semibold)
                    if !detail.isEmpty { Text(detail).foregroundStyle(.secondary).lineLimit(2) }
                }
                .font(.footnote)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(.regularMaterial, in: Capsule())
                .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
                .padding(.horizontal, 16)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
            Spacer()
        }
        .padding(.top, 8)
    }
}
#endif
