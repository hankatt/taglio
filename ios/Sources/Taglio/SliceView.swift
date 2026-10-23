#if DEBUG && canImport(UIKit)
import SwiftUI
import UIKit

@MainActor
final class SliceModel: ObservableObject {
    enum Phase { case select, note }

    let capture: Capture
    let mailbox: Mailbox
    var onClose: (String?) -> Void = { _ in }

    @Published var phase = Phase.select
    @Published var rect: CGRect?
    @Published var note = ""
    @Published var sending = false
    @Published var error: String?
    @Published var project: String?

    init(capture: Capture, mailbox: Mailbox) {
        self.capture = capture
        self.mailbox = mailbox
        project = mailbox.project
    }

    var crop: UIImage? { rect.map { capture.crop($0) } }

    func choose(_ rect: CGRect) {
        self.rect = rect.intersection(CGRect(origin: .zero, size: capture.size))
        phase = .note
    }

    func reslice() {
        rect = nil
        error = nil
        phase = .select
    }

    func cancel() { onClose(nil) }

    /// A note needs at least this many characters before it can be sent.
    static let shortest = 3

    var noteIsLongEnough: Bool { note.trimmingCharacters(in: .whitespacesAndNewlines).count >= Self.shortest }

    func send() {
        guard let rect, !sending else { return }
        guard noteIsLongEnough else {
            withAnimation(.smooth(duration: 0.25)) {
                error = "Minimum \(Self.shortest) characters"
            }
            return
        }
        sending = true
        error = nil
        Task {
            // On an iPhone the elements can take a moment longer than the picture.
            await capture.ready()
            save(rect)
        }
    }

    private func save(_ rect: CGRect) {
        let image = capture.crop(rect).pngData().map { "data:image/png;base64,\($0.base64EncodedString())" }
        let info = Bundle.main.infoDictionary
        let screen = UIScreen.main
        let payload = Payload(
            note: note.trimmingCharacters(in: .whitespacesAndNewlines),
            screen: capture.screen,
            app: .init(
                bundleId: Bundle.main.bundleIdentifier,
                name: info?["CFBundleDisplayName"] as? String ?? info?["CFBundleName"] as? String,
                version: info?["CFBundleShortVersionString"] as? String,
                build: info?["CFBundleVersion"] as? String
            ),
            device: .init(
                model: UIDevice.current.model,
                system: "iOS \(UIDevice.current.systemVersion)",
                scale: Double(screen.scale),
                width: Int(capture.size.width),
                height: Int(capture.size.height)
            ),
            rect: .init(x: Int(rect.minX), y: Int(rect.minY), width: Int(rect.width), height: Int(rect.height)),
            elements: capture.elements(in: rect),
            png: image
        )
        do {
            onClose(try mailbox.send(payload))
        } catch {
            self.error = "Couldn't save the note: \(error.localizedDescription)"
            sending = false
        }
    }

    private static var automated = false

    /// For automated tests in the simulator: TAGLIO_TEST="x,y,width,height|note"
    /// chooses that slice and writes that note, and TAGLIO_TEST_SEND=1 sends it.
    func automateIfAsked() {
        let env = ProcessInfo.processInfo.environment
        // Only the first slice after launch, so later ones are left to you.
        guard !SliceModel.automated, let test = env["TAGLIO_TEST"] else { return }
        SliceModel.automated = true
        let parts = test.split(separator: "|", maxSplits: 1).map(String.init)
        let numbers = parts[0].split(separator: ",").compactMap { Double($0) }
        guard numbers.count == 4 else { return }
        choose(CGRect(x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3]))
        note = parts.count > 1 ? parts[1] : ""
        if env["TAGLIO_TEST_SEND"] == "1" { send() }
    }
}

/// The frozen screen. Drag round what you mean, or tap one element. Then
/// the slice shows at the top of a card with the note under it.
struct SliceView: View {
    @ObservedObject var model: SliceModel
    @State private var from: CGPoint?
    @State private var dragging: CGRect?
    @FocusState private var focused: Bool

    var body: some View {
        // The frozen screen sits behind, filling the window, while the hint
        // and the card keep to the safe area and move up with the keyboard.
        // Touches that miss them reach the frozen screen.
        VStack {
            if model.phase == .select {
                hint
                Spacer()
            } else {
                Spacer()
                card
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(alignment: .topLeading) {
            frozen
                .ignoresSafeArea()
        }
        .animation(.smooth(duration: 0.25), value: model.phase)
    }

    // The selection shows only while choosing. Once the card is up, the
    // slice is in the card, and the whole screen behind it dims evenly.
    private var shown: CGRect? { model.phase == .select ? dragging ?? model.rect : nil }

    private var frozen: some View {
        ZStack(alignment: .topLeading) {
            Image(uiImage: model.capture.image)
                .resizable()
                .frame(width: model.capture.size.width, height: model.capture.size.height)
            // Everything but the slice is dimmed.
            Path { path in
                path.addRect(CGRect(origin: .zero, size: model.capture.size))
                if let rect = shown { path.addRoundedRect(in: rect, cornerSize: CGSize(width: 4, height: 4)) }
            }
            .fill(Color.black.opacity(0.45), style: FillStyle(eoFill: true))
            if let rect = shown {
                RoundedRectangle(cornerRadius: 4)
                    .stroke(Color.accentColor, lineWidth: 2)
                    .frame(width: rect.width, height: rect.height)
                    .offset(x: rect.minX, y: rect.minY)
            }
        }
        .frame(width: model.capture.size.width, height: model.capture.size.height, alignment: .topLeading)
        .contentShape(Rectangle())
        .gesture(select, including: model.phase == .select ? .all : .none)
    }

    private var select: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { value in
                let start = from ?? value.startLocation
                from = start
                dragging = CGRect(
                    x: min(start.x, value.location.x), y: min(start.y, value.location.y),
                    width: abs(value.location.x - start.x), height: abs(value.location.y - start.y)
                )
            }
            .onEnded { value in
                defer { from = nil; dragging = nil }
                guard let rect = dragging else { return }
                if rect.width < 10, rect.height < 10 {
                    // A tap takes the element under it.
                    if let element = model.capture.element(at: value.location) { model.choose(element.rect) }
                    return
                }
                model.choose(rect)
            }
    }

    private var hint: some View {
        HStack(spacing: 12) {
            Text("Drag round what you mean, or tap an element")
                .font(.footnote.weight(.medium))
            Button("Cancel") { model.cancel() }
                .font(.footnote.weight(.semibold))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.regularMaterial, in: Capsule())
        .padding(.top, 8)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let crop = model.crop {
                // The slice at its own shape, as wide as the card (the window
                // less the card's margins and padding) and up to 220 points tall.
                let width = model.capture.size.width - 56
                let height = min(220, width * crop.size.height / max(crop.size.width, 1))
                Image(uiImage: crop)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.primary.opacity(0.12)))
                    .frame(maxWidth: .infinity)
                    .frame(height: height)
            }
            TextField("What should change?", text: $model.note, axis: .vertical)
                // One line to start, growing to six as the note gets longer.
                .lineLimit(1...6)
                .focused($focused)
                // Typing again clears the message: it fades out while its
                // row closes, so the buttons slide up.
                .onChange(of: model.note) { _ in
                    guard model.error != nil else { return }
                    withAnimation(.smooth(duration: 0.25)) { model.error = nil }
                }
            if let error = model.error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .transition(.opacity)
            }
            HStack(spacing: 4) {
                Text(model.project ?? "Waits for /taglio")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                Button { model.cancel() } label: { icon("xmark", "Cancel") }
                    .roundButton()
                Button { model.reslice() } label: { icon("crop", "Reslice") }
                    .roundButton()
                Button {
                    model.send()
                } label: {
                    if model.sending { ProgressView().tint(.white).frame(width: 40, height: 40) } else { icon("paperplane.fill", "Send") }
                }
                .roundButton(prominent: true)
                .disabled(model.sending)
            }
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22))
        .padding(12)
        .onAppear { focused = true }
    }

    private func icon(_ name: String, _ label: String) -> some View {
        Image(systemName: name)
            .font(.system(size: 16, weight: .semibold))
            .frame(width: 40, height: 40)
            .contentShape(Circle())
            .accessibilityLabel(label)
    }
}

private extension View {
    /// A 40-point round button, like the system's close button: Liquid Glass
    /// on iOS 26 and later, a filled circle before it. The prominent one is
    /// tinted with the app's accent color.
    @ViewBuilder
    func roundButton(prominent: Bool = false) -> some View {
        let button = buttonStyle(.plain).foregroundStyle(prominent ? Color.white : Color.primary)
        if #available(iOS 26.0, *) {
            button.glassEffect(prominent ? .regular.tint(.accentColor).interactive() : .regular.interactive(), in: Circle())
        } else {
            button.background(prominent ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.regularMaterial), in: Circle())
        }
    }
}
#endif
