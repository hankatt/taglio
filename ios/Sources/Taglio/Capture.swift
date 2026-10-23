#if DEBUG && canImport(UIKit)
import UIKit

/// One accessibility element on screen, as it goes in the note.
struct Element: Encodable {
    /// What it is, from its accessibility traits: button, text, image, header, link and so on.
    let kind: String
    let label: String?
    let value: String?
    let identifier: String?
    /// The class behind it, like `UIButton` or a SwiftUI accessibility node.
    let type: String
    /// x, y, width and height in points, in the window.
    let frame: [Int]

    var rect: CGRect { CGRect(x: frame[0], y: frame[1], width: frame[2], height: frame[3]) }
}

/// The screen at the moment taglio was triggered: a picture of the key
/// window and every accessibility element in it. The picture is taken at
/// once; the elements follow, within two seconds on an iPhone (see
/// AppAccessibility).
@MainActor
final class Capture {
    let image: UIImage
    let screen: String
    let size: CGSize
    private(set) var elements: [Element] = []
    private var loading: Task<Void, Never>?

    private init(image: UIImage, screen: String, size: CGSize) {
        self.image = image
        self.screen = screen
        self.size = size
    }

    static func take(_ window: UIWindow) -> Capture {
        let format = UIGraphicsImageRendererFormat(for: window.traitCollection)
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
        }
        let capture = Capture(image: image, screen: screenName(window), size: window.bounds.size)
        capture.loading = Task {
            capture.elements = await AppAccessibility.read {
                var elements: [Element] = []
                collect(window, in: window, into: &elements, depth: 0)
                return elements
            }
        }
        return capture
    }

    /// Waits until the elements are read.
    func ready() async {
        await loading?.value
    }

    /// The elements that overlap `rect`, smallest first, since the smallest
    /// is usually the one the note is about.
    func elements(in rect: CGRect) -> [Element] {
        elements
            .filter { $0.rect.intersects(rect) }
            .sorted { $0.rect.width * $0.rect.height < $1.rect.width * $1.rect.height }
            .prefix(30)
            .map { $0 }
    }

    /// The smallest element under a point, for a tap rather than a drag.
    func element(at point: CGPoint) -> Element? {
        elements
            .filter { $0.rect.contains(point) }
            .min { $0.rect.width * $0.rect.height < $1.rect.width * $1.rect.height }
    }

    /// The part of the picture inside `rect`, at the screen's scale.
    func crop(_ rect: CGRect) -> UIImage {
        let scale = image.scale
        let pixels = CGRect(x: rect.minX * scale, y: rect.minY * scale, width: rect.width * scale, height: rect.height * scale).integral
        guard let cg = image.cgImage?.cropping(to: pixels) else { return image }
        return UIImage(cgImage: cg, scale: scale, orientation: .up)
    }

    // Walks the accessibility tree, which SwiftUI and UIKit both build, and
    // which holds the text and identifiers that lead to the code. Where an
    // object has no accessibility children, its subviews are walked instead.
    @MainActor
    private static func collect(_ object: NSObject, in window: UIWindow, into out: inout [Element], depth: Int) {
        guard depth < 80, out.count < 600 else { return }
        if let view = object as? UIView, view.isHidden || view.alpha < 0.01 { return }
        if object.isAccessibilityElement {
            let screenFrame = object.accessibilityFrame
            let frame = window.convert(screenFrame, from: window.screen.coordinateSpace)
            if frame.width > 0, frame.height > 0 {
                out.append(Element(
                    kind: kind(object.accessibilityTraits),
                    label: nonEmpty(object.accessibilityLabel),
                    value: nonEmpty(object.accessibilityValue),
                    identifier: nonEmpty((object as? UIAccessibilityIdentification)?.accessibilityIdentifier),
                    type: String(describing: type(of: object)),
                    frame: [frame.minX, frame.minY, frame.width, frame.height].map { Int($0.rounded()) }
                ))
            }
            return
        }
        var children: [NSObject] = []
        if let elements = object.accessibilityElements as? [NSObject] {
            children = elements
        } else {
            let count = object.accessibilityElementCount()
            if count != NSNotFound, count > 0 {
                children = (0..<count).compactMap { object.accessibilityElement(at: $0) as? NSObject }
            }
        }
        if children.isEmpty, let view = object as? UIView {
            children = view.subviews
        }
        for child in children {
            collect(child, in: window, into: &out, depth: depth + 1)
        }
    }

    private static func nonEmpty(_ text: String?) -> String? {
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return text
    }

    private static func kind(_ traits: UIAccessibilityTraits) -> String {
        let names: [(UIAccessibilityTraits, String)] = [
            (.button, "button"), (.link, "link"), (.header, "header"), (.searchField, "search field"),
            (.image, "image"), (.adjustable, "adjustable"), (.tabBar, "tab bar"), (.staticText, "text")
        ]
        return names.first { traits.contains($0.0) }?.1 ?? "element"
    }

    // The view controller on top, which for a SwiftUI app names the hosting
    // controller and often the root view's type.
    @MainActor
    private static func screenName(_ window: UIWindow) -> String {
        var top = window.rootViewController
        while true {
            if let presented = top?.presentedViewController { top = presented; continue }
            if let nav = top as? UINavigationController, let visible = nav.visibleViewController { top = visible; continue }
            if let tab = top as? UITabBarController, let selected = tab.selectedViewController { top = selected; continue }
            break
        }
        guard let top else { return "unknown" }
        return String(String(describing: type(of: top)).prefix(200))
    }
}
#endif
