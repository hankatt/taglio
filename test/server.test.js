import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer, setStatus, unhandled, saveNote } from '../lib/server.js'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

async function withServer(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taglio-'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo-app' }))
  const notes = []
  const server = createServer({ root, port: 0, onNote: (n) => notes.push(n) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await fn({ root, base, notes })
  } finally {
    server.close()
  }
}

const post = (base, origin, body) =>
  fetch(`${base}/notes`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

test('health names the project', async () => {
  await withServer(async ({ base }) => {
    const health = await (await fetch(`${base}/health`)).json()
    assert.equal(health.ok, true)
    assert.equal(health.project, 'demo-app')
  })
})

test('a note from localhost is saved and reported, with its picture', async () => {
  await withServer(async ({ root, base, notes }) => {
    const res = await post(base, 'http://localhost:5173', { note: 'Make it yellow', url: '/', png: PNG, elements: [] })
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.ok, true)
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173')
    assert.equal(notes.length, 1)
    assert.equal(notes[0].note, 'Make it yellow')
    const record = JSON.parse(fs.readFileSync(notes[0].json, 'utf8'))
    assert.equal(record.png, undefined)
    assert.ok(fs.existsSync(record.image))
    assert.ok(record.image.startsWith(path.join(root, '.taglio')))
  })
})

test('a note from another website is refused', async () => {
  await withServer(async ({ base, notes }) => {
    const res = await post(base, 'https://evil.example', { note: 'rm -rf' })
    assert.equal(res.status, 403)
    assert.equal(res.headers.get('access-control-allow-origin'), null)
    assert.equal(notes.length, 0)
  })
})

test('an origin listed in config.json may send notes', async () => {
  await withServer(async ({ root, base, notes }) => {
    fs.mkdirSync(path.join(root, '.taglio'), { recursive: true })
    fs.writeFileSync(path.join(root, '.taglio', 'config.json'), JSON.stringify({ origins: ['https://staging.example.com'] }))
    const res = await post(base, 'https://staging.example.com', { note: 'Hi' })
    assert.equal(res.status, 200)
    assert.equal(notes.length, 1)
  })
})

test('status goes from queued to what taglio status wrote', async () => {
  await withServer(async ({ root, base }) => {
    const { id } = await (await post(base, 'http://localhost:3000', { note: 'x' })).json()
    const ask = async () => (await (await fetch(`${base}/status?ids=${id}`, { headers: { Origin: 'http://localhost:3000' } })).json())[id]
    assert.equal((await ask()).state, 'queued')
    setStatus(root, id, 'done', 'Changed it')
    assert.deepEqual({ ...(await ask()), at: undefined }, { state: 'done', message: 'Changed it', at: undefined })
  })
})

test('notes never given a status are picked up again, oldest first', async () => {
  await withServer(async ({ root, base }) => {
    const a = (await (await post(base, 'http://localhost:3000', { note: 'first' })).json()).id
    await new Promise((r) => setTimeout(r, 5))
    const b = (await (await post(base, 'http://localhost:3000', { note: 'second' })).json()).id
    setStatus(root, a, 'done')
    assert.deepEqual(unhandled(root).map((n) => n.id), [b])
  })
})

test('the overlay is served for script tags, with the screenshot library beside it', async () => {
  await withServer(async ({ base }) => {
    const entry = await (await fetch(`${base}/overlay.js`)).text()
    assert.match(entry, /mount\(\{ port: \d+ \}\)/)
    const overlay = await (await fetch(`${base}/client/overlay.js`)).text()
    assert.match(overlay, /from '\.\/modern-screenshot\.js'/)
    const lib = await fetch(`${base}/client/modern-screenshot.js`)
    assert.equal(lib.status, 200)
    assert.match(await lib.text(), /domToPng/)
  })
})

test('a note from the iOS app, with no Origin, is taken when it names itself', async () => {
  await withServer(async ({ base, notes }) => {
    const res = await fetch(`${base}/notes`, {
      method: 'POST',
      headers: { 'X-Taglio-Client': 'ios', 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Bigger title', platform: 'ios', screen: 'ContentView', png: PNG })
    })
    assert.equal(res.status, 200)
    assert.equal(notes[0].platform, 'ios')
    assert.equal(notes[0].screen, 'ContentView')
    const status = await fetch(`${base}/status?ids=${notes[0].id}`, { headers: { 'X-Taglio-Client': 'ios' } })
    assert.equal(status.status, 200)
  })
})

test('a request with neither an Origin nor the app header is refused', async () => {
  await withServer(async ({ base, notes }) => {
    const res = await fetch(`${base}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"note":"x"}' })
    assert.equal(res.status, 403)
    assert.equal(notes.length, 0)
  })
})

test('a note from an iOS app keeps its own id, so its status finds its way back', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taglio-'))
  const note = saveNote(root, { note: 'Bigger title', platform: 'ios', screen: 'Feed', png: PNG }, { id: '2026-10-23T07-23-29-813Z', origin: 'ios app on iPhone' })
  assert.equal(note.id, '2026-10-23T07-23-29-813Z')
  assert.equal(note.platform, 'ios')
  assert.ok(fs.existsSync(path.join(root, '.taglio', '2026-10-23T07-23-29-813Z.png')))
  assert.deepEqual(unhandled(root).map((n) => n.id), ['2026-10-23T07-23-29-813Z'])
  // An id that could reach outside .taglio/ is replaced.
  assert.match(saveNote(root, { note: 'x' }, { id: '../../etc' }).id, /^\d{4}-/)
})
