// Collects notes from iOS apps, for `taglio watch` in an Xcode project.
//
// The app saves each note as a file in its own container (see the Swift
// package's Mailbox) and never opens a network connection. Every two
// seconds the watch looks in the app's container on each booted simulator,
// straight from disk, and on each iPhone Xcode is connected to, over the
// cable or Wi-Fi, through `xcrun devicectl`. It saves new notes in .taglio/
// like notes from the web, and writes each note's status and its own
// heartbeat back into the container, for the app to show.
//
// Only a Mac the iPhone trusts for development can reach the container, and
// only of a debug build, so there's nothing else to approve.

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { saveNote, notesDir, projectName } from './server.js'
import { findProject, appTarget } from './xcode.js'

const BOX = 'Library/Application Support/taglio'
const EVERY = 2000
const HEARTBEAT = 10000

const run = (command, args, timeout = 20000) =>
  new Promise((resolve) => execFile(command, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout)))

const temp = (name) => path.join(os.tmpdir(), `taglio-${crypto.randomBytes(6).toString('hex')}-${name}`)

// devicectl reports in JSON through a file.
async function devicectl(args) {
  const file = temp('out.json')
  await run('xcrun', ['devicectl', ...args, '--json-output', file])
  try {
    const out = JSON.parse(fs.readFileSync(file, 'utf8'))
    return out.info?.outcome === 'success' ? out.result : null
  } catch {
    return null
  } finally {
    fs.rmSync(file, { force: true })
  }
}

// The app's bundle ID, from the Debug configuration of the project's app
// target, or `bundleId` in .taglio/config.json.
export function bundleId(root) {
  try {
    const { bundleId } = JSON.parse(fs.readFileSync(path.join(root, '.taglio', 'config.json'), 'utf8'))
    if (bundleId) return bundleId
  } catch {}
  const project = findProject(root)
  if (!project) return null
  const text = fs.readFileSync(path.join(root, project, 'project.pbxproj'), 'utf8')
  const target = appTarget(text, project.replace(/\.xcodeproj$/, ''))
  const listId = target?.text.match(/buildConfigurationList = (\w{24})/)?.[1]
  const list = listId && text.match(new RegExp(`\\n\\t\\t${listId} /\\*[^*]*\\*/ = \\{[\\s\\S]*?\\n\\t\\t\\};`))?.[0]
  if (!list) return null
  const configs = [...list.matchAll(/\t\t\t\t(\w{24}) \/\* (.+?) \*\/,/g)]
  const debug = configs.find((c) => c[2] === 'Debug') || configs[0]
  const block = debug && text.match(new RegExp(`\\n\\t\\t${debug[1]} /\\*[^*]*\\*/ = \\{[\\s\\S]*?\\n\\t\\t\\};`))?.[0]
  const id = block?.match(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/)?.[1]
  return id && !id.includes('$') ? id : null
}

// The app's container on each booted simulator that has it installed.
async function simulators(bundle) {
  const out = await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'])
  if (!out) return []
  const booted = Object.values(JSON.parse(out).devices).flat().filter((d) => d.state === 'Booted')
  const found = []
  for (const device of booted) {
    const container = (await run('xcrun', ['simctl', 'get_app_container', device.udid, bundle, 'data']))?.trim()
    if (container) found.push(simulator(device, path.join(container, BOX)))
  }
  return found
}

const simulator = (device, box) => ({
  key: device.udid,
  name: `${device.name} (simulator)`,
  async list() {
    try {
      return fs.readdirSync(path.join(box, 'outbox'))
    } catch {
      return null
    }
  },
  async read(file) {
    return fs.readFileSync(path.join(box, 'outbox', file), 'utf8')
  },
  async write(relative, text) {
    fs.mkdirSync(path.dirname(path.join(box, relative)), { recursive: true })
    fs.writeFileSync(path.join(box, relative), text)
    return true
  }
})

// Each iPhone or iPad Xcode can reach now, over the cable or Wi-Fi.
async function iphones(bundle) {
  const result = await devicectl(['list', 'devices'])
  return (result?.devices || [])
    .filter((d) => d.hardwareProperties?.reality === 'physical' && d.connectionProperties?.pairingState === 'paired' && d.connectionProperties?.transportType)
    .map((d) => iphone(d.hardwareProperties.udid || d.identifier, d.deviceProperties?.name || 'iPhone', bundle))
}

function iphone(id, name, bundle) {
  const domain = ['--device', id, '--domain-type', 'appDataContainer', '--domain-identifier', bundle]
  return {
    key: id,
    name,
    async list() {
      const result = await devicectl(['device', 'info', 'files', ...domain, '--subdirectory', `${BOX}/outbox`])
      return result ? result.files.map((f) => f.relativePath).filter((f) => !f.includes('/')) : null
    },
    async read(file) {
      const local = temp(file)
      await devicectl(['device', 'copy', 'from', ...domain, '--source', `${BOX}/outbox/${file}`, '--destination', local])
      try {
        return fs.readFileSync(local, 'utf8')
      } finally {
        fs.rmSync(local, { force: true })
      }
    },
    async write(relative, text) {
      const local = temp(path.basename(relative))
      fs.writeFileSync(local, text)
      const done = await devicectl(['device', 'copy', 'to', ...domain, '--source', local, '--destination', `${BOX}/${relative}`])
      fs.rmSync(local, { force: true })
      return Boolean(done)
    }
  }
}

export function watchApple({ root, bundle, onNote }) {
  const project = projectName(root)
  const dir = notesDir(root)
  // Each note from an app: where it came from and the status last sent back.
  const notes = new Map()
  const beats = new Map()
  const away = new Map()
  let devices = []
  let listed = 0
  let stopped = false

  async function visit(place) {
    const files = await place.list()
    // The app isn't installed, or the device didn't answer; try again later.
    if (!files) return away.set(place.key, Date.now())
    for (const file of files.filter((f) => /^[\w-]+\.json$/.test(f))) {
      const id = file.slice(0, -'.json'.length)
      if (notes.has(id)) continue
      // Saved by an earlier watch, which already printed it.
      if (fs.existsSync(path.join(dir, file))) {
        notes.set(id, { place, sent: 0 })
        continue
      }
      let body
      try {
        body = JSON.parse(await place.read(file))
      } catch {
        continue
      }
      notes.set(id, { place, sent: 0 })
      onNote(saveNote(root, body, { id, origin: `ios app on ${place.name}` }))
      if (!fs.existsSync(path.join(dir, `${id}.status.json`))) await place.write(`status/${id}.json`, JSON.stringify({ state: 'received' }))
    }
    // Statuses `taglio status` wrote since the last visit.
    for (const [id, note] of notes) {
      if (note.place.key !== place.key) continue
      const file = path.join(dir, `${id}.status.json`)
      const changed = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0
      if (changed > note.sent && (await place.write(`status/${id}.json`, fs.readFileSync(file, 'utf8')))) note.sent = changed
    }
    if (Date.now() - (beats.get(place.key) || 0) > HEARTBEAT) {
      if (await place.write('watch.json', JSON.stringify({ project, at: Date.now() }))) beats.set(place.key, Date.now())
    }
  }

  // Each simulator and iPhone goes at its own pace, so a slow or missing
  // iPhone never holds up the simulator.
  const busy = new Set()
  async function round() {
    if (Date.now() - listed > HEARTBEAT) {
      listed = Date.now()
      devices = await iphones(bundle)
    }
    for (const place of [...(await simulators(bundle)), ...devices]) {
      if (busy.has(place.key) || Date.now() - (away.get(place.key) || 0) < HEARTBEAT) continue
      busy.add(place.key)
      visit(place)
        .catch(() => away.set(place.key, Date.now()))
        .finally(() => busy.delete(place.key))
    }
  }

  ;(async () => {
    while (!stopped) {
      const started = Date.now()
      await round()
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, EVERY - (Date.now() - started))))
    }
  })()
  return { stop: () => (stopped = true) }
}
