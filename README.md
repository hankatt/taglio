# taglio

Point at your running app instead of describing it.

Slice the part of the screen you mean, write a note, and taglio sends it to your terminal with a
picture of the slice and the elements under it. In Claude Code, the `/taglio` command picks each
note up and makes the change, and your app shows the note go from Sent to Processing to Done.

- **Web apps** in React, Vue, Svelte, Next.js or plain HTML. Press the pencil in the corner. Notes
  carry each element's selector, text and computed styles.
- **iOS apps** in SwiftUI or UIKit. Hold three fingers on the screen, in the simulator or on your
  iPhone. Notes carry each element's accessibility label, identifier and frame.

```sh
npx @taglio/cli init
```

taglio runs only on your machine and only in development builds. It never ships in a production
build. taglio itself sends nothing over the internet, and notes stay in your project's `.taglio/`
folder until Claude Code reads them.

## Set up

taglio is set up one project at a time, by you. Nothing is installed for the whole machine. You
need Node 18 or later and Claude Code.

### Web apps

In your project's folder:

```sh
npx @taglio/cli init
```

`init` installs taglio as a dev dependency, finds your framework and loads the pencil in the
development build only. It also gives the project its own port, adds `.taglio/` to `.gitignore` and
adds the `/taglio` command to the project's Claude Code. It works with Vite (React, Vue, Svelte and
others on Vite), Next.js (app and pages router), Create React App and plain HTML.

Then:

1. Start your dev server and open the app. A magenta pencil sits in the bottom left corner.
2. Open Claude Code in the project folder and type `/taglio`. The dot on the pencil turns green.
3. Press the pencil, or Alt+Shift+S. Drag round what you mean, or click a single element. Type the
   note and press Enter. Esc cancels.

You can start slicing before step 2. Notes wait in the browser, through reloads, and go to the
terminal as soon as it connects.

### iOS apps

In the folder with your `.xcodeproj`:

```sh
npx @taglio/cli init
```

`init` adds the Taglio Swift package to your app target, starts it in your `App`'s `init()` behind
`#if DEBUG`, adds `.taglio/` to `.gitignore` and adds `/taglio` to the project's Claude Code.

Then:

1. Run the app from Xcode, in the simulator or on your iPhone, over the cable or Wi-Fi.
2. Open Claude Code in the project folder and type `/taglio`.
3. In the app, hold three fingers anywhere on the screen for a moment, or shake it. In the
   simulator, use Device > Shake.
   Drag round what you mean, or tap one element, write the note under the slice and press Send.

There's nothing to allow on the iPhone. The app never opens a network connection. It saves each
note in its own container, and `taglio watch` collects it through the same connection Xcode uses
to install the app. A release build gets an empty module. See [ios/README.md](ios/README.md).

## Without Claude Code

`npx taglio watch` connects the page to any terminal. In an Xcode project, which has no
`package.json` to install taglio into, use `npx @taglio/cli watch` and `npx @taglio/cli status`
instead. In a terminal you read, it prints each note with the paths to its details and picture. When another program reads its output, it prints one
line of JSON per note:

```json
{"id":"2026-10-22T19-43-44-465Z","note":"Make the heading magenta","url":"/","json":".taglio/2026-10-22T19-43-44-465Z.json","image":".taglio/2026-10-22T19-43-44-465Z.png"}
```

Mark a note's progress, which the tray in the page shows:

```sh
npx taglio status <id> processing
npx taglio status <id> done "Heading is magenta now"
npx taglio status <id> failed "Couldn't find that component"
```

## What a note holds

`.taglio/<id>.json` has the note, the page's URL and title, the viewport, the slice's rectangle and
up to 16 elements under the slice. Each element has a selector (its tag, id and classes, and those
of three ancestors), its text, and its font, color, background, margin, padding and opacity.
`.taglio/<id>.png` is the slice at up to twice its size on screen.

## Setting it up by hand

If `init` can't find a web app's entry, add this to the code that runs first in the browser, with
the port from `package.json`'s `taglio.port`:

```js
if (process.env.NODE_ENV === 'development') import('@taglio/cli').then(({ mount }) => mount({ port: 4519 }))
```

For a page you don't build, `taglio watch` also serves the overlay as a script:

```html
<script type="module" src="http://localhost:4519/overlay.js"></script>
```

## Several projects at once

Each project gets its own port from its name, between 4520 and 4999, and `init` saves it in
`package.json`. The pencil's tooltip names the project it's connected to. To pick another port,
change `taglio.port` and the port in the `mount()` call.

## Security

A note becomes an instruction to Claude, so `taglio watch` listens on 127.0.0.1 only and takes notes
only from pages on localhost. Notes from any other website get a 403. To allow another address,
like a staging site, list it in `.taglio/config.json`:

```json
{ "origins": ["https://staging.example.com"] }
```

Notes from an iOS app come only from a simulator on this Mac, or from an iPhone that trusts this Mac
for development, through `xcrun devicectl`. The iOS app itself opens no network connection.

The `/taglio` command also tells Claude to ask in the chat before doing anything a note asks for
beyond changing the app, like deleting files, pushing or deploying.

## Limits

- modern-screenshot draws the picture from the page's HTML and CSS, so effects like backdrop blur
  can look slightly different from the screen. The element details are always exact.
- A page with a strict Content Security Policy may block the connection to localhost.
- The slice works with a mouse or trackpad. Touch isn't supported yet.

## Android

Not built yet. [docs/native.md](docs/native.md) has the plan and what's been tried.

## License

MIT
