# taglio on iOS and Android

taglio works in web apps. This note looks at how it can work in native apps. Option 2 for iOS now
exists as a prototype Swift package, described in [ios/README.md](../ios/README.md); the rest isn't
built yet.

A web note has three parts, and a native note needs the same three:

1. **A picture of the slice.** It shows Claude what the user sees.
2. **The elements under the slice.** Their text and identifiers let Claude find the code.
3. **A way to reach `taglio watch`** on the developer's Mac, which hands the note to Claude Code.

There are two ways to get them: from the Mac, by reading the simulator or emulator from outside,
or from inside the app, with a small library in debug builds.

## Option 1: slice the simulator from the Mac

`taglio watch` could serve a page, say `http://localhost:4519/device`, that shows the screen of
the running iOS Simulator or Android emulator. The user slices on that page with the pencil they
already know, and the server adds what it can read about the screen.

| | iOS Simulator | Android emulator or USB device |
|---|---|---|
| Screen | `xcrun simctl io booted screenshot` | `adb exec-out screencap -p` |
| Elements | None from `simctl`. An XCUITest runner or idb's `ui describe-all` can read the accessibility tree. | `adb shell uiautomator dump` gives every view with its bounds, text, class, `resource-id` and `content-desc` |
| App code to add | None | None |

**For it.** It needs no change to the app and no SDK, and works for any app on the simulator,
including SwiftUI, UIKit, Jetpack Compose, React Native and Flutter. On Android, `uiautomator`'s
`resource-id` names the view's ID in the layout XML, so Claude can go straight to the code.

**Against it.** The screen is a still that the page refreshes, not the live app, so the user
switches between the simulator and the page. On iOS, outside tools see the accessibility tree at
best, so notes carry the picture and the visible text. It doesn't reach a physical iPhone.

## Option 2: a library inside the app, in debug builds

The pencil floats over the app itself, as it does on the web. The user slices on the device, with
a finger.

### Android

- **Install.** `debugImplementation("…:taglio-android")`. An `androidx.startup` initializer starts
  it with the app, so there's no code to add and release builds never include it. LeakCanary starts
  itself the same way.
- **Overlay.** An `ActivityLifecycleCallbacks` adds the pencil to each activity's window.
- **Picture.** `PixelCopy.request()` copies the window's pixels, Views and Compose alike.
- **Elements.** For Views, a walk of the view tree gives each view's class, ID name
  (`resources.getResourceEntryName`) and text. For Compose, the semantics tree gives text, content
  descriptions and `testTag`s.
- **Reaching the Mac.** `adb reverse tcp:4519 tcp:4519` makes `localhost:4519` on the device reach
  the Mac, on the emulator and on a USB device. `taglio watch` could run it when it sees `adb`.

### iOS

- **Install.** A Swift package, started with `#if DEBUG Taglio.start() #endif` in the app's entry.
  Swift Package Manager has no debug-only dependencies, so the `#if DEBUG` keeps it out of release
  builds.
- **Overlay.** A separate `UIWindow` above the app's own holds the pencil and the slice, so it
  doesn't change the app's view tree.
- **Picture.** `drawHierarchy(in:afterScreenUpdates:)` with `UIGraphicsImageRenderer` draws the
  app's window.
- **Elements.** UIKit views give class names, `accessibilityIdentifier`s and text. SwiftUI views
  have no class names of their own, so the accessibility tree is the useful source: labels,
  identifiers and values. Claude then finds the code by searching for the visible text, which works
  well in SwiftUI, where the strings usually sit in the view's own code.
- **Reaching the Mac.** The app opens no network connection. It saves each note as a file in its
  own container, and `taglio watch` collects it: from a simulator straight from disk, and from an
  iPhone through `xcrun devicectl`, which uses the connection Xcode installs apps over, by cable or
  Wi-Fi. Anything over the network would make iOS ask the user for local network access the first
  time, with or without Bonjour. Going through the phone's own loopback with usbmuxd avoids that
  too, but only over a cable: an iPhone Xcode reaches over Wi-Fi doesn't show up in usbmuxd.

### React Native, Expo and Flutter

These can use a library in their own language. React Native can capture with
`react-native-view-shot`, read component names from the React tree in development, and reach the
Mac at the Metro bundler's host. Flutter can capture with `RepaintBoundary.toImage()` and read the
widget tree the Flutter inspector uses.

## What the note looks like

The note's JSON stays the same, with `platform` added and native identifiers in `elements`:

```json
{
  "note": "Make this button match the one on the home screen",
  "platform": "ios",
  "screen": "SettingsView",
  "rect": { "x": 24, "y": 610, "width": 342, "height": 52 },
  "elements": [
    { "kind": "Button", "text": "Sign out", "identifier": "settings.signOut", "frame": [24, 610, 342, 52] }
  ]
}
```

The `/taglio` command in Claude Code works the same for every platform. It reads the note, finds
the code and marks the note done, and the tray on the device shows it.

## Tried on a Mac

These ran on a Mac with Xcode 27 and the Android SDK, in October 2026, against apps already on a
simulator and an emulator, with no change to either app.

- **Android screen.** `adb exec-out screencap -p` returned a full-size PNG in 0.3 seconds.
- **Android elements.** `adb exec-out uiautomator dump /dev/tty` returned the view tree in 2.3
  seconds. On a Jetpack Compose screen it gave every text with its exact bounds, but no
  `resource-id`s, since Compose only reports `testTag`s as IDs when the app turns on
  `testTagsAsResourceId`. Bounds are enough to pick the elements under a slice.
- **iOS screen.** `xcrun simctl io <device> screenshot` returned a full-size PNG of a SwiftUI app in
  1.1 seconds.
- **iOS elements.** Xcode has no command-line tool that reads an app's accessibility tree. It takes
  a third-party tool (idb or AXe), an XCUITest runner, or the library from option 2.
- **iOS elements from inside the app.** The prototype library walks the app's own accessibility
  tree when it's triggered. In a SwiftUI app, a slice over one list card returned every element on
  it: the title, a link and a date as text, an icon as an image and a button, each with its frame.
  It needs no change to the app's views. On an iPhone, SwiftUI builds that tree only while the
  system's app accessibility setting is on, so the library turns it on for the moment it reads.
- **Finding iOS code from text alone.** Of two strings on the screen, a search of the app's Swift
  code found one, the `Text` that draws it. The other wasn't in the code at all,
  because the installed build was older than the checkout. Text search fails the same way for
  strings that are localized or built at runtime, so iOS notes need real element details to be
  reliable.
- **Files on a real iPhone.** Over Wi-Fi, with no cable, `devicectl` listed a folder in a debug
  app's container in 0.7 seconds, copied a file out in 0.6 and copied one in in 2.9. The phone
  showed no prompt. Two of eight calls failed with a CoreDevice error and worked when tried again,
  so the watch tries again on its next round.

## Recommendation

1. **Start with option 1 in `taglio watch`.** It works with every simulator app at once and needs
   nothing in the app. On Android it gives the picture and every element. On iOS it gives the
   picture and nothing else, which is enough to try the flow but not enough for Claude to find the
   code every time.
2. **Then the Android library.** `debugImplementation` plus `adb reverse` makes it install with one
   line and connect with no setup, on emulators and phones.
3. **Then the iOS library**, for slicing on a physical iPhone. Built as a prototype: notes travel as
   files through `devicectl`, so it needs no network setup and no permission on the phone.
