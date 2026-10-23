// swift-tools-version:5.9
// taglio for iOS: slice part of your app's screen, add a note, and send both
// to `taglio watch` on your Mac. See ios/README.md.
import PackageDescription

let package = Package(
    name: "Taglio",
    platforms: [.iOS(.v16)],
    products: [
        .library(name: "Taglio", targets: ["Taglio"])
    ],
    targets: [
        .target(name: "Taglio", path: "ios/Sources/Taglio")
    ]
)
