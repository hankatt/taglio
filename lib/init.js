// `taglio init`: sets taglio up in the project in the current folder.
//
// It works out the framework, loads the pencil in the app's development
// build only, gives the project its own port (so several projects can run
// side by side), keeps .taglio/ out of git and adds the /taglio command to
// Claude Code. Each step is safe to run again: one that's already done is
// skipped.

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setUpXcode, PACKAGE_URL } from './xcode.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MARK = 'taglio'
const COMMENT = 'taglio: slice part of the page and send it to your terminal with a note (development only).'

// Where `init` installs taglio from, and what an Xcode project's /taglio runs.
export const SOURCE = '@taglio/cli'

const read = (file) => fs.readFileSync(file, 'utf8')
const exists = (...parts) => fs.existsSync(path.join(...parts))
const first = (root, candidates) => candidates.find((c) => exists(root, c))

export function readPackage(root) {
  try {
    return JSON.parse(read(path.join(root, 'package.json')))
  } catch {
    return null
  }
}

const deps = (pkg) => ({ ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) })

// A port from the project's name, between 4520 and 4999, so the same
// project always gets the same one and two projects rarely share one.
export function portFor(name) {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return 4520 + (hash % 480)
}

// Where the port is kept: package.json's "taglio" field, or for a project
// without one, .taglio/config.json.
export function configuredPort(root) {
  const fromPackage = readPackage(root)?.taglio?.port
  if (fromPackage) return Number(fromPackage)
  try {
    const port = JSON.parse(read(path.join(root, '.taglio', 'config.json'))).port
    if (port) return Number(port)
  } catch {}
  return null
}

// Which framework the project uses and the file the pencil goes in.
export function detect(root) {
  const pkg = readPackage(root)
  const d = deps(pkg)
  const ext = ['tsx', 'jsx', 'ts', 'js']
  const any = (base) => ext.map((e) => `${base}.${e}`)

  if (d.next) {
    const layout = first(root, [...any('app/layout'), ...any('src/app/layout')])
    if (layout) return { framework: 'Next.js (app router)', kind: 'next-app', file: layout }
    const app = first(root, [...any('pages/_app'), ...any('src/pages/_app')])
    if (app) return { framework: 'Next.js (pages router)', kind: 'module', file: app, guard: "typeof window !== 'undefined' && process.env.NODE_ENV === 'development'" }
    return { framework: 'Next.js', kind: 'manual' }
  }
  if (d.vite) {
    // Vite's entry is the module script in index.html.
    let file = null
    if (exists(root, 'index.html')) {
      const src = read(path.join(root, 'index.html')).match(/<script[^>]*type=["']module["'][^>]*src=["']\/?([^"']+)["']/)
      if (src && exists(root, src[1])) file = src[1]
    }
    file = file || first(root, [...any('src/main'), ...any('src/index')])
    return file ? { framework: 'Vite', kind: 'module', file, guard: 'import.meta.env.DEV' } : { framework: 'Vite', kind: 'manual' }
  }
  if (d['react-scripts']) {
    const file = first(root, any('src/index'))
    return file ? { framework: 'Create React App', kind: 'module', file, guard: "process.env.NODE_ENV === 'development'" } : { framework: 'Create React App', kind: 'manual' }
  }
  const xcode = fs.readdirSync(root).find((f) => f.endsWith('.xcodeproj'))
  if (!pkg && xcode) return { framework: 'iOS (Xcode)', kind: 'ios', file: xcode }
  if (!pkg && exists(root, 'index.html')) return { framework: 'plain HTML', kind: 'html', file: 'index.html' }
  if (pkg) {
    const file = first(root, [...any('src/main'), ...any('src/index')])
    if (file) return { framework: 'a bundled app', kind: 'module', file, guard: "process.env.NODE_ENV === 'development'" }
  }
  return { framework: 'unknown', kind: 'manual' }
}

const moduleSnippet = (guard, port) =>
  `\n// ${COMMENT}\nif (${guard}) import('@taglio/cli').then(({ mount }) => mount({ port: ${port} }))\n`

const htmlSnippet = (port) =>
  `<script type="module">
  // ${COMMENT}
  if (['localhost', '127.0.0.1'].includes(location.hostname)) import('http://localhost:${port}/overlay.js').catch(() => {})
</script>
`

const nextComponent = (port, ts) => `'use client'
// ${COMMENT}
import { useEffect } from 'react'

export default function Taglio()${ts ? ': null' : ''} {
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') import('@taglio/cli').then(({ mount }) => mount({ port: ${port} }))
  }, [])
  return null
}
`

// Adds an import after the file's last import, or at the top.
function addImport(source, line) {
  const imports = [...source.matchAll(/^import .*$/gm)]
  if (!imports.length) return `${line}\n${source}`
  const last = imports[imports.length - 1]
  const at = last.index + last[0].length
  return `${source.slice(0, at)}\n${line}${source.slice(at)}`
}

// Wires the pencil in. Returns what it did, for the summary.
function wire(root, found, port) {
  const { kind, file } = found
  if (kind === 'manual' || kind === 'ios') return { done: false }
  const full = path.join(root, file)
  const source = read(full)
  if (source.includes(MARK)) return { done: true, file, already: true }

  if (kind === 'module') {
    fs.writeFileSync(full, source.replace(/\s*$/, '\n') + moduleSnippet(found.guard, port))
    return { done: true, file }
  }
  if (kind === 'html') {
    const at = source.lastIndexOf('</body>')
    if (at === -1) return { done: false }
    fs.writeFileSync(full, source.slice(0, at) + htmlSnippet(port) + source.slice(at))
    return { done: true, file }
  }
  if (kind === 'next-app') {
    const ts = file.endsWith('.tsx') || file.endsWith('.ts')
    const component = path.join(path.dirname(file), `taglio.${ts ? 'tsx' : 'jsx'}`)
    const body = source.match(/<body[^>]*>/)
    if (!body) return { done: false }
    if (!exists(root, component)) fs.writeFileSync(path.join(root, component), nextComponent(port, ts))
    let next = source.replace(body[0], `${body[0]}\n        <Taglio />`)
    next = addImport(next, "import Taglio from './taglio'")
    fs.writeFileSync(full, next)
    return { done: true, file, also: component }
  }
  return { done: false }
}

function savePort(root, port) {
  const file = path.join(root, 'package.json')
  if (fs.existsSync(file)) {
    const text = read(file)
    const pkg = JSON.parse(text)
    if (pkg.taglio?.port === port) return
    pkg.taglio = { ...(pkg.taglio || {}), port }
    const indent = text.match(/^[ \t]+(?=")/m)?.[0] || '  '
    fs.writeFileSync(file, JSON.stringify(pkg, null, indent) + '\n')
    return
  }
  const dir = path.join(root, '.taglio')
  fs.mkdirSync(dir, { recursive: true })
  const config = path.join(dir, 'config.json')
  let current = {}
  try {
    current = JSON.parse(read(config))
  } catch {}
  fs.writeFileSync(config, JSON.stringify({ ...current, port }, null, 2) + '\n')
}

function ignore(root) {
  const file = path.join(root, '.gitignore')
  const text = fs.existsSync(file) ? read(file) : ''
  if (/^\/?\.taglio\/?$/m.test(text)) return false
  fs.writeFileSync(file, `${text.replace(/\s*$/, text ? '\n\n' : '')}# taglio's notes and screenshots\n.taglio/\n`)
  return true
}

// The command the skill runs taglio with. A web project has taglio
// installed; an Xcode project has no package.json, so npx fetches it.
function addSkill(root, port, ios) {
  const dir = path.join(root, '.claude', 'skills', 'taglio')
  fs.mkdirSync(dir, { recursive: true })
  const skill = read(path.join(HERE, '..', 'skill', 'SKILL.md'))
    .replaceAll('__PORT__', String(port))
    .replaceAll('__TAGLIO__', ios ? `npx -y ${SOURCE}` : 'npx taglio')
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skill)
}

export function packageManager(root) {
  if (exists(root, 'pnpm-lock.yaml')) return 'pnpm add -D'
  if (exists(root, 'yarn.lock')) return 'yarn add -D'
  if (exists(root, 'bun.lockb') || exists(root, 'bun.lock')) return 'bun add -d'
  return 'npm i -D'
}

export function init(root, { log = console.log, install = true } = {}) {
  const pkg = readPackage(root)
  // `npx @taglio/cli init` runs taglio without installing it, so init adds
  // it to the project as a dev dependency first.
  let installed = false
  if (pkg && !deps(pkg)[SOURCE] && install) {
    const command = `${packageManager(root)} ${SOURCE}`
    log(`Installing taglio: ${command}`)
    try {
      execSync(command, { cwd: root, stdio: 'inherit' })
      installed = true
    } catch {
      log(`Couldn't install taglio. Run \`${command}\` yourself.`)
    }
  }
  const port = configuredPort(root) || portFor(pkg?.name || path.basename(root))
  const found = detect(root)
  const result = wire(root, found, port)
  // An iOS app needs no port: its notes come through its container.
  const xcode = found.kind === 'ios' ? setUpXcode(root) : null
  if (!xcode) savePort(root, port)
  const ignored = ignore(root)
  addSkill(root, port, found.kind === 'ios')

  const lines = [`taglio, set up for ${found.framework}${xcode ? '' : ` on port ${port}`}`, '']
  if (xcode?.error) {
    lines.push(`  ! ${xcode.error}. Add the Swift package by hand: File > Add Package Dependencies,`, `      ${PACKAGE_URL}, product Taglio, and call Taglio.start() in a debug build.`)
  } else if (xcode) {
    lines.push(xcode.done.includes('package') ? `  ✓ added the Taglio package to ${xcode.target}` : `  ✓ ${xcode.target} already has the Taglio package`)
    if (xcode.started?.already) lines.push(`  ✓ ${xcode.started.file} already starts taglio`)
    else if (xcode.started) lines.push(`  ✓ starts taglio in debug builds, in ${xcode.started.file}`)
    else lines.push("  ! couldn't find the App or app delegate. Add this where the app starts:", '      #if DEBUG', '      Taglio.start()', '      #endif', '    and import Taglio at the top of that file.')
  } else if (result.done && result.already) lines.push(`  ✓ ${result.file} already loads the pencil`)
  else if (result.done) lines.push(`  ✓ loads the pencil in development, in ${result.file}${result.also ? ` (and ${result.also})` : ''}`)
  else {
    lines.push("  ! couldn't find where to load the pencil. Add this to your app's client entry:")
    lines.push(moduleSnippet("process.env.NODE_ENV === 'development'", port).trim().split('\n').map((l) => `      ${l}`).join('\n'))
  }
  lines.push(`  ✓ ${ignored ? 'added .taglio/ to' : '.taglio/ already in'} .gitignore`)
  lines.push('  ✓ added /taglio to Claude Code (.claude/skills/taglio)')
  if (installed) lines.push(`  ✓ installed taglio as a dev dependency`)
  else if (pkg && !deps(pkg)[SOURCE]) lines.push('', `  Install it in the project: ${packageManager(root)} ${SOURCE}`)
  lines.push(
    '',
    'Next:',
    ...(found.kind === 'ios'
      ? [
          '  1. Open the project in Xcode and run the app, in the simulator or on your iPhone.',
          '  2. In Claude Code, in this folder, type /taglio.',
          '  3. In the app, hold three fingers on the screen for a moment, or shake it. In the',
          '     simulator, use Device > Shake.',
          '     Drag round what you mean, write the note under the slice and press Send.'
        ]
      : [
          '  1. Start your dev server and open the app. A magenta pencil sits in the bottom left.',
          "  2. In Claude Code, in this folder, type /taglio. The pencil's dot turns green.",
          '  3. Press the pencil (or Alt+Shift+S), drag round what you mean, type a note and press Enter.'
        ]),
    '',
    `No Claude Code? \`${found.kind === 'ios' ? `npx ${SOURCE}` : 'npx taglio'} watch\` prints the notes in any terminal.`
  )
  log(lines.join('\n'))
  return { port, found, result }
}
