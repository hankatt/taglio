import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { init, portFor, configuredPort } from '../lib/init.js'
import { bundleId } from '../lib/apple.js'

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taglio-init-'))
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
  return root
}
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8')
const quiet = { install: false, log: () => {} }

test('Vite: loads the pencil from the entry index.html names, in development only', () => {
  const root = project({
    'package.json': { name: 'vite-app', devDependencies: { vite: '^5' } },
    'index.html': '<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>',
    'src/main.tsx': "import React from 'react'\ncreateRoot(el).render(<App />)\n"
  })
  const { port } = init(root, quiet)
  const main = read(root, 'src/main.tsx')
  assert.match(main, /if \(import\.meta\.env\.DEV\) import\('taglio'\)\.then\(\(\{ mount \}\) => mount\(\{ port: \d+ \}\)\)/)
  assert.equal(port, portFor('vite-app'))
  assert.equal(JSON.parse(read(root, 'package.json')).taglio.port, port)
  assert.match(read(root, '.gitignore'), /^\.taglio\/$/m)
  assert.match(read(root, '.claude/skills/taglio/SKILL.md'), new RegExp(`port ${port}`))
})

test('running init twice changes nothing more', () => {
  const root = project({
    'package.json': { name: 'cra', dependencies: { 'react-scripts': '5' } },
    'src/index.js': "import App from './App'\n",
    '.gitignore': 'node_modules\n'
  })
  init(root, quiet)
  const once = ['src/index.js', '.gitignore', 'package.json'].map((f) => read(root, f))
  init(root, quiet)
  assert.deepEqual(['src/index.js', '.gitignore', 'package.json'].map((f) => read(root, f)), once)
  assert.match(once[0], /process\.env\.NODE_ENV === 'development'/)
})

test('Next.js app router: adds a client component inside <body>', () => {
  const root = project({
    'package.json': { name: 'next-app', dependencies: { next: '15' } },
    'app/layout.tsx': "import './globals.css'\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang=\"en\">\n      <body className=\"x\">\n        {children}\n      </body>\n    </html>\n  )\n}\n"
  })
  init(root, quiet)
  const layout = read(root, 'app/layout.tsx')
  assert.match(layout, /import Taglio from '\.\/taglio'/)
  assert.match(layout, /<body className="x">\n\s+<Taglio \/>/)
  const component = read(root, 'app/taglio.tsx')
  assert.match(component, /^'use client'/)
  assert.match(component, /process\.env\.NODE_ENV === 'development'/)
})

test('Next.js pages router: loads it from _app in the browser only', () => {
  const root = project({
    'package.json': { name: 'pages', dependencies: { next: '14' } },
    'pages/_app.js': 'export default function App({ Component, pageProps }) { return <Component {...pageProps} /> }\n'
  })
  init(root, quiet)
  assert.match(read(root, 'pages/_app.js'), /typeof window !== 'undefined' && process\.env\.NODE_ENV === 'development'/)
})

test('plain HTML: a script that only loads on localhost, and the port in .taglio/config.json', () => {
  const root = project({ 'index.html': '<html><body><h1>Hi</h1></body></html>' })
  const { port } = init(root, quiet)
  const html = read(root, 'index.html')
  assert.match(html, new RegExp(`import\\('http://localhost:${port}/overlay\\.js'\\)`))
  assert.ok(html.indexOf('overlay.js') < html.indexOf('</body>'))
  assert.equal(configuredPort(root), port)
})

test('ports differ between projects and stay in range', () => {
  const ports = ['a', 'my-site', 'shop', 'portfolio-2026'].map(portFor)
  assert.equal(new Set(ports).size, ports.length)
  for (const p of ports) assert.ok(p >= 4520 && p < 5000)
})

const FIXTURE = fs.readFileSync(new URL('./fixtures/MyApp.pbxproj', import.meta.url), 'utf8')
const APP = 'import SwiftUI\n\n@main\nstruct MyAppApp: App {\n    var body: some Scene {\n        WindowGroup { Text("Hi") }\n    }\n}\n'

test('an Xcode project: adds the package and the start line, and needs no port', () => {
  const root = project({ 'MyApp.xcodeproj/project.pbxproj': FIXTURE, 'MyApp/MyAppApp.swift': APP })
  let printed = ''
  const { found } = init(root, { install: false, log: (text) => { printed += text } })
  assert.equal(found.kind, 'ios')
  const pbx = read(root, 'MyApp.xcodeproj/project.pbxproj')
  assert.match(pbx, /repositoryURL = "https:\/\/github.com\/hankatt\/taglio";/)
  assert.match(pbx, /packageReferences = \(\n\t\t\t\t\w{24} \/\* XCRemoteSwiftPackageReference "taglio" \*\/,/)
  assert.match(pbx, /packageProductDependencies = \(\n\t\t\t\t\w{24} \/\* Taglio \*\/,/)
  assert.match(pbx, /files = \(\n\t\t\t\t\w{24} \/\* Taglio in Frameworks \*\/,/)
  assert.ok(!pbx.includes('PBXShellScriptBuildPhase'))
  assert.ok(!fs.existsSync(path.join(root, '.taglio', 'config.json')))
  assert.equal(bundleId(root), 'com.example.MyApp')
  const app = read(root, 'MyApp/MyAppApp.swift')
  assert.match(app, /import SwiftUI\nimport Taglio\n/)
  assert.match(app, /struct MyAppApp: App \{\n    init\(\) \{\n        \/\/ taglio[\s\S]*?#if DEBUG\n        Taglio\.start\(\)\n        #endif\n    \}\n/)
  assert.match(printed, /added the Taglio package to MyApp/)
  assert.doesNotMatch(printed, /port/)
  assert.match(read(root, '.gitignore'), /^\.taglio\/$/m)
})

test('an Xcode project: running init again changes nothing', () => {
  const root = project({ 'MyApp.xcodeproj/project.pbxproj': FIXTURE, 'MyApp/MyAppApp.swift': APP })
  init(root, quiet)
  const pbx = read(root, 'MyApp.xcodeproj/project.pbxproj')
  const app = read(root, 'MyApp/MyAppApp.swift')
  init(root, quiet)
  assert.equal(read(root, 'MyApp.xcodeproj/project.pbxproj'), pbx)
  assert.equal(read(root, 'MyApp/MyAppApp.swift'), app)
})

test('an Xcode project: an App with its own init() gets the start line inside it', () => {
  const source = 'import SwiftUI\n\n@main\nstruct MyAppApp: App {\n    init() {\n        setUp()\n    }\n\n    var body: some Scene { WindowGroup { Text("Hi") } }\n}\n'
  const root = project({ 'MyApp.xcodeproj/project.pbxproj': FIXTURE, 'MyApp/MyAppApp.swift': source })
  init(root, quiet)
  assert.match(read(root, 'MyApp/MyAppApp.swift'), /    init\(\) \{\n        \/\/ taglio[\s\S]*?        #endif\n        setUp\(\)\n/)
})
