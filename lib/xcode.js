// Sets taglio up in an Xcode project, for `taglio init`:
//
// - adds the Taglio Swift package to the app target;
// - starts taglio in the SwiftUI App's init() or the app delegate.
//
// project.pbxproj is an old-style property list. The edits are made as text,
// in the format Xcode writes, so the rest of the file stays as it was. Each
// step that's already done is skipped.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const PACKAGE_URL = 'https://github.com/hankatt/taglio'
export const findProject = (root) => fs.readdirSync(root).find((f) => f.endsWith('.xcodeproj')) || null
const pbxprojPath = (root, project) => path.join(root, project, 'project.pbxproj')
const read = (file) => fs.readFileSync(file, 'utf8')

const quote = (value) => (/^[\w./-]+$/.test(value) ? value : `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)

function newId(text) {
  for (;;) {
    const id = crypto.randomBytes(12).toString('hex').toUpperCase()
    if (!text.includes(id)) return id
  }
}

// The text of the object with this id, as start and end offsets.
function objectRange(text, id) {
  const start = text.search(new RegExp(`\\n\\t\\t${id}(?: /\\*.*?\\*/)? = \\{`))
  if (start === -1) return null
  const end = text.indexOf('\n\t\t};', start)
  return { start: start + 1, end: end + '\n\t\t};'.length }
}

// Adds an object to its section, making the section if the file has none.
function addObject(text, isa, entry) {
  const end = `/* End ${isa} section */`
  if (text.includes(end)) return text.replace(end, `${entry}\n${end}`)
  const close = text.lastIndexOf('\n\t};\n\trootObject')
  return `${text.slice(0, close)}\n\n/* Begin ${isa} section */\n${entry}\n${end}${text.slice(close)}`
}

// Adds an item to a list like `buildPhases = (...)` inside one object,
// making the list before `before` if the object has none.
function addToList(text, id, key, item, before) {
  const range = objectRange(text, id)
  let body = text.slice(range.start, range.end)
  const open = `\n\t\t\t${key} = (\n`
  const at = body.indexOf(open)
  if (at !== -1) {
    const close = body.indexOf('\n\t\t\t);', at)
    body = `${body.slice(0, close)}\n\t\t\t\t${item},${body.slice(close)}`
  } else {
    const anchor = body.indexOf(`\n\t\t\t${before} =`)
    const where = anchor === -1 ? body.lastIndexOf('\n\t\t};') : anchor
    body = `${body.slice(0, where)}\n\t\t\t${key} = (\n\t\t\t\t${item},\n\t\t\t);${body.slice(where)}`
  }
  return text.slice(0, range.start) + body + text.slice(range.end)
}

// The app's target: the application target named like the project, or the
// first application target.
export function appTarget(text, name) {
  const targets = [...text.matchAll(/\n\t\t(\w{24}) \/\* (.*?) \*\/ = \{\n\t\t\tisa = PBXNativeTarget;[\s\S]*?\n\t\t\};/g)]
    .filter((m) => m[0].includes('productType = "com.apple.product-type.application";'))
    .map((m) => ({ id: m[1], name: m[2], text: m[0] }))
  return targets.find((t) => t.name === name) || targets[0] || null
}

export function editProject(text, { name, packageUrl = PACKAGE_URL }) {
  const target = appTarget(text, name)
  if (!target) return { text, error: 'no app target' }
  const done = []
  const projectId = text.match(/\n\trootObject = (\w{24})/)[1]

  if (!/productName = Taglio;/.test(text)) {
    let packageId = text.match(/\n\t\t(\w{24}) \/\* XC(?:Remote|Local)SwiftPackageReference "[^"]*taglio[^"]*" \*\//)?.[1]
    if (!packageId) {
      packageId = newId(text)
      const comment = `/* XCRemoteSwiftPackageReference "taglio" */`
      text = addObject(text, 'XCRemoteSwiftPackageReference',
        `\t\t${packageId} ${comment} = {\n\t\t\tisa = XCRemoteSwiftPackageReference;\n\t\t\trepositoryURL = ${quote(packageUrl)};\n\t\t\trequirement = {\n\t\t\t\tbranch = main;\n\t\t\t\tkind = branch;\n\t\t\t};\n\t\t};`)
      text = addToList(text, projectId, 'packageReferences', `${packageId} ${comment}`, 'preferredProjectObjectVersion')
    }
    const productId = newId(text)
    text = addObject(text, 'XCSwiftPackageProductDependency',
      `\t\t${productId} /* Taglio */ = {\n\t\t\tisa = XCSwiftPackageProductDependency;\n\t\t\tpackage = ${packageId};\n\t\t\tproductName = Taglio;\n\t\t};`)
    text = addToList(text, target.id, 'packageProductDependencies', `${productId} /* Taglio */`, 'productName')
    const fileId = newId(text)
    text = addObject(text, 'PBXBuildFile', `\t\t${fileId} /* Taglio in Frameworks */ = {isa = PBXBuildFile; productRef = ${productId} /* Taglio */; };`)
    const frameworks = [...appTarget(text, name).text.matchAll(/\t\t\t\t(\w{24}) \/\* Frameworks \*\/,/g)][0]?.[1]
    let phase = frameworks
    if (!phase) {
      phase = newId(text)
      text = addObject(text, 'PBXFrameworksBuildPhase', `\t\t${phase} /* Frameworks */ = {\n\t\t\tisa = PBXFrameworksBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};`)
      text = addToList(text, target.id, 'buildPhases', `${phase} /* Frameworks */`, 'buildRules')
    }
    text = addToList(text, phase, 'files', `${fileId} /* Taglio in Frameworks */`, 'runOnlyForDeploymentPostprocessing')
    done.push('package')
  }

  return { text, done, target: target.name }
}

// The Swift file that starts the app: a SwiftUI App or an app delegate.
function findEntry(root) {
  const skip = new Set(['Pods', 'Carthage', 'DerivedData', 'build', '.build', 'node_modules', '.git'])
  const files = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name) || entry.name.endsWith('.xcodeproj')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name.endsWith('.swift')) files.push(full)
    }
  }
  walk(root, 0)
  for (const file of files) {
    const source = read(file)
    if (/@main\s+struct\s+\w+\s*:\s*(?:SwiftUI\.)?App\b/.test(source)) return { file, kind: 'swiftui', source }
  }
  for (const file of files) {
    const source = read(file)
    if (/@main|@UIApplicationMain/.test(source) && source.includes('didFinishLaunchingWithOptions')) return { file, kind: 'delegate', source }
  }
  return null
}

const startLines = (indent) =>
  [
    '// taglio: take a screenshot or shake to slice part of the screen and send it',
    '// to Claude Code with a note. Debug builds only.',
    '#if DEBUG',
    'Taglio.start()',
    '#endif'
  ].map((line) => indent + line)

export function addStart(source, kind) {
  if (source.includes('Taglio.start')) return null
  const imports = [...source.matchAll(/^import .*$/gm)]
  if (!imports.some((m) => m[0] === 'import Taglio')) {
    const last = imports[imports.length - 1]
    source = last ? `${source.slice(0, last.index + last[0].length)}\nimport Taglio${source.slice(last.index + last[0].length)}` : `import Taglio\n${source}`
  }
  if (kind === 'delegate') {
    const open = source.match(/didFinishLaunchingWithOptions[^{]*\{\n(\s*)/)
    if (!open) return null
    const at = open.index + open[0].length - open[1].length
    return source.slice(0, at) + startLines(open[1]).join('\n') + '\n' + source.slice(at)
  }
  const struct = source.match(/@main\s+struct\s+\w+\s*:\s*(?:SwiftUI\.)?App\b[^{]*\{\n/)
  const rest = source.slice(struct.index + struct[0].length)
  const indent = rest.match(/^([ \t]+)\S/m)?.[1] || '    '
  // An init() at the struct's own level.
  const init = new RegExp(`^${indent}init\\(\\)\\s*\\{\\n`, 'm').exec(rest)
  if (init) {
    const at = struct.index + struct[0].length + init.index + init[0].length
    return source.slice(0, at) + startLines(indent + indent).join('\n') + '\n' + source.slice(at)
  }
  const at = struct.index + struct[0].length
  const block = [`${indent}init() {`, ...startLines(indent + indent), `${indent}}`, ''].join('\n')
  return source.slice(0, at) + block + '\n' + source.slice(at)
}

export function setUpXcode(root) {
  const project = findProject(root)
  const file = pbxprojPath(root, project)
  const edited = editProject(read(file), { name: project.replace(/\.xcodeproj$/, '') })
  if (edited.error) return { error: `couldn't find an app target in ${project}` }
  if (edited.done.length) fs.writeFileSync(file, edited.text)

  const entry = findEntry(root)
  let started = null
  if (entry) {
    const next = addStart(entry.source, entry.kind)
    if (next) fs.writeFileSync(entry.file, next)
    started = { file: path.relative(root, entry.file), already: !next && entry.source.includes('Taglio.start') }
  }
  return { project, target: edited.target, done: edited.done, started }
}
