# taglio for iOS

A Swift package for your app's debug build. Hold three fingers on the screen for a moment, or
shake the device, and taglio freezes the screen. Drag round what you mean, or tap one element,
write a note under the slice and press Send. The note goes to `taglio watch` on your Mac with a
picture of the slice and the accessibility elements under it: their labels, identifiers and frames.
A pill at the top of the app shows when Claude starts and finishes.

This is a prototype, tested in the iOS Simulator and on an iPhone over Wi-Fi.

## Set up

In the folder with your `.xcodeproj`, run `npx taglio init`. It adds the package to
your app target and this to your `App`'s `init()`:

```swift
#if DEBUG
Taglio.start()
#endif
```

To do it by hand instead: in Xcode, File > Add Package Dependencies, enter
`https://github.com/hankatt/taglio`, add the **Taglio** product to your app target, and add the
lines above with `import Taglio` at the top of the file.

Release builds compile the package to an empty module, and `start()` does nothing there.

## Use it

1. Run the app from Xcode, in the simulator or on your iPhone.
2. In Claude Code, in the project folder, type `/taglio`.
3. In the app, hold three fingers anywhere on the screen for a moment, or shake it. In the
   simulator, use Device > Shake.

The three-finger press never blocks the app's own touches. A screenshot isn't a trigger, because
iOS always opens its own screenshot preview on top. For another trigger, like a row in your own
debug menu, call `Taglio.slice()`.

To open the slice from the Mac, for example in a script:

```sh
xcrun simctl spawn booted notifyutil -p dev.taglio.slice
xcrun devicectl device notification post --device <id> --name dev.taglio.slice
```

## How notes reach the Mac

The app opens no network connection, so iOS never asks for permission. It saves each note in its
own container, under `Library/Application Support/taglio/outbox`. Every two seconds,
`taglio watch` looks there:

- in each booted simulator, straight from disk (`xcrun simctl get_app_container`);
- on each iPhone Xcode can reach, over the cable or Wi-Fi (`xcrun devicectl device copy from`).

It writes each note's status, and a heartbeat with the project's name, back into the container the
same way, and the app shows them. Only a Mac the iPhone trusts for development can read the
container, and only of a debug build. A note from the simulator reaches the terminal in under a
second. On an iPhone, listing the outbox takes about 0.7 seconds and writing a status back about 3.

The watch finds the app's bundle ID in the Debug configuration of the project's app target. If it
can't, add it to `.taglio/config.json`:

```json
{ "bundleId": "com.example.app" }
```

## What a note holds

The note has the same shape as one from a web page, with `platform: "ios"`, the app's bundle ID,
version and build, the device, the top view controller's type, the slice's rectangle in points, a
PNG of the slice at the screen's scale, and up to 30 accessibility elements under the slice, smallest
first. SwiftUI and UIKit both fill the accessibility tree, so SwiftUI `Text` views come through with
their text and frame.
