// The local server behind `taglio watch`. It runs from the root of your
// project and:
//
// - answers /health, so the page's pencil shows it's connected, and to which
//   project;
// - takes notes from the page (POST /notes) and saves each one in .taglio/:
//   the note and its details as JSON and the slice as a PNG;
// - answers the page's questions about where each note is (GET /status),
//   from the status files `taglio status` writes;
// - serves the overlay as a script (/overlay.js), for pages that don't
//   bundle it, like plain HTML or a bookmarklet.
//
// It only listens on this machine (127.0.0.1) and only takes notes from
// localhost and the origins listed in .taglio/config.json, since a note
// becomes an instruction to Claude and no other website should be able to
// send one. No dependencies beyond Node 18.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OVERLAY = path.join(HERE, '..', 'client', 'overlay.js')
const require = createRequire(import.meta.url)
export const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version
const LIMIT = 40 * 1024 * 1024

export const notesDir = (root) => path.join(root, '.taglio')

// The project's name, for the pencil to show: package.json's name, or the
// folder's.
export function projectName(root) {
  try {
    const name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name
    if (name) return name
  } catch {}
  return path.basename(root)
}

function extraOrigins(dir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
    return Array.isArray(config.origins) ? config.origins : []
  } catch {
    return []
  }
}

// Localhost on any port always may send notes; more can be listed in
// .taglio/config.json, like a staging site used with the bookmarklet.
export function allowed(origin, dir) {
  if (!origin) return false
  try {
    const { hostname } = new URL(origin)
    if (['localhost', '127.0.0.1', '[::1]'].includes(hostname) || hostname.endsWith('.localhost')) return true
  } catch {
    return false
  }
  return extraOrigins(dir).includes(origin)
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > LIMIT) {
        reject(new Error('Note too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

// Notes saved but never given a status, oldest first, so a watch that
// starts again picks up what the last one missed.
export function unhandled(root) {
  const dir = notesDir(root)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => /^[\w-]+\.json$/.test(f) && !f.endsWith('.status.json') && f !== 'config.json')
    .map((f) => f.slice(0, -'.json'.length))
    .filter((id) => !fs.existsSync(path.join(dir, `${id}.status.json`)))
    .sort()
    .map((id) => summary(root, JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'))))
}

// What the terminal gets for each note: enough to start, and the path to
// the full details.
export const summary = (root, record) => ({
  id: record.id,
  note: record.note,
  ...(record.platform && { platform: record.platform, screen: record.screen }),
  url: record.url,
  json: path.join(notesDir(root), `${record.id}.json`),
  image: record.image
})

// Saves a note in .taglio/: its details as JSON and its slice as a PNG.
// Notes from the web get an id here; notes from an iOS app bring their own.
export function saveNote(root, body, { origin, id } = {}) {
  const dir = notesDir(root)
  fs.mkdirSync(dir, { recursive: true })
  id = /^[\w-]+$/.test(id || '') ? id : new Date().toISOString().replace(/[:.]/g, '-')
  let image = null
  if (typeof body.png === 'string' && body.png.startsWith('data:image/png;base64,')) {
    image = path.join(dir, `${id}.png`)
    fs.writeFileSync(image, Buffer.from(body.png.slice('data:image/png;base64,'.length), 'base64'))
  }
  const { png, ...rest } = body
  const record = { ...rest, id, origin, image }
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(record, null, 2))
  return summary(root, record)
}

export function createServer({ root, port, onNote = () => {} }) {
  const dir = notesDir(root)
  const project = projectName(root)

  const json = (res, status, body) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    const text = JSON.stringify(body)
    res.setHeader('Content-Length', Buffer.byteLength(text))
    res.end(text)
  }

  const script = (res, body) => {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    // Scripts are safe to load from anywhere; only notes are guarded.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.end(body)
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`)
    const origin = req.headers.origin
    // A native app, reaching the watch through a port forward like
    // `adb reverse`, sends no Origin and names itself in X-Taglio-Client. A web page can't do that: a browser always sends
    // Origin with a cross-site request, and a custom header makes it ask
    // first, which the server refuses for other sites.
    const native = !origin && Boolean(req.headers['x-taglio-client'])
    const may = native || allowed(origin, dir)
    if (allowed(origin, dir)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      // Lets an https page reach this local server in Chrome.
      res.setHeader('Access-Control-Allow-Private-Network', 'true')
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = allowed(origin, dir) ? 204 : 403
      res.end()
      return
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, project, version: VERSION, root })
    }

    // The overlay for pages that load it as a script rather than bundling
    // it, with the screenshot library served from here too.
    if (req.method === 'GET' && url.pathname === '/overlay.js') {
      return script(res, `import { mount } from 'http://localhost:${port}/client/overlay.js'\nmount({ port: ${port} })\n`)
    }
    if (req.method === 'GET' && url.pathname === '/client/overlay.js') {
      return script(res, fs.readFileSync(OVERLAY, 'utf8').replace("from 'modern-screenshot'", "from './modern-screenshot.js'"))
    }
    if (req.method === 'GET' && url.pathname === '/client/modern-screenshot.js') {
      return script(res, fs.readFileSync(require.resolve('modern-screenshot').replace(/index\.c?js$/, 'index.mjs'), 'utf8'))
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      if (!may) return json(res, 403, { ok: false })
      const out = {}
      for (const id of (url.searchParams.get('ids') || '').split(',').filter((id) => /^[\w-]+$/.test(id))) {
        try {
          out[id] = JSON.parse(fs.readFileSync(path.join(dir, `${id}.status.json`), 'utf8'))
        } catch {
          out[id] = { state: 'queued' }
        }
      }
      return json(res, 200, out)
    }

    if (req.method === 'POST' && url.pathname === '/notes') {
      if (!may) return json(res, 403, { ok: false, error: `${origin || 'This page'} isn't allowed to send notes. Add it to .taglio/config.json.` })
      try {
        const note = saveNote(root, JSON.parse(await readBody(req)), { origin: origin || `${req.headers['x-taglio-client']} app` })
        onNote(note)
        return json(res, 200, { ok: true, id: note.id })
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error.message || error) })
      }
    }

    json(res, 404, { ok: false })
  })
}

export function setStatus(root, id, state, message) {
  const dir = notesDir(root)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${id}.status.json`), JSON.stringify({ state, message: message || null, at: new Date().toISOString() }))
}
