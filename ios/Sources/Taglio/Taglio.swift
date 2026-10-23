// taglio for iOS. Call Taglio.start() once, early, in a debug build:
//
//     #if DEBUG
//     Taglio.start()
//     #endif
//
// Then hold three fingers on the screen for a moment, or shake the
// device. taglio freezes the screen, you drag round what you mean, write a
// note under the slice and send it to `taglio watch` on your Mac. The note
// carries a picture of the slice and the accessibility elements under it:
// their labels, identifiers and frames.
//
// The app opens no network connection. Notes wait as files in the app's own
// container, and `taglio watch` collects them through Xcode's connection to
// the simulator or the iPhone (see Mailbox).
//
// Everything here is compiled into debug builds only. In a release build
// start() does nothing and the module is empty.

#if DEBUG && canImport(UIKit)
import UIKit

public enum Taglio {
    /// Starts listening for a three-finger press and for shakes.
    @MainActor
    public static func start() {
        Controller.shared.start()
    }

    /// Opens the slice now, as a three-finger press or a shake would. Call it
    /// from your own debug menu or gesture, if you'd like another trigger.
    @MainActor
    public static func slice() {
        Controller.shared.trigger()
    }
}

#else

public enum Taglio {
    public static func start() {}
    public static func slice() {}
}

#endif
