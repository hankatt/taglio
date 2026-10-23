// The taglio overlay: a pencil in the page's bottom left corner. Press it, or
// Alt+Shift+S, drag round what you mean (or click one element), type a note
// and press Enter or Send. Esc cancels. It sends a PNG of the slice, the
// note, the URL and the elements under the slice, with their text, classes
// and key styles, to `taglio watch` in your terminal, which saves them and
// hands them to Claude Code. The tray beside the pencil shows each note's
// status: Sent, Processing, Done.
//
// A dot on the pencil shows whether a terminal is connected. Notes sent while
// none is wait in the browser (IndexedDB, so a reload keeps them) and go as
// soon as one connects.
//
// Plain DOM rather than React, so it works with any framework and can't
// disturb the page's own rendering.

import { domToPng } from 'modern-screenshot'

const BLUE = '#0a84ff'
const MAGENTA = '#f0f'
const Z = 2147483000
const FONT = '-apple-system, system-ui, sans-serif'

let SERVER = 'http://localhost:4519'
let KEY = 'taglio:4519'

const css = (el, styles) => Object.assign(el.style, styles)

const make = (tag, styles, parent = document.body) => {
  const el = document.createElement(tag)
  el.dataset.taglio = ''
  css(el, styles)
  parent.appendChild(el)
  return el
}

// A short selector for an element: its tag, id and classes, and the same
// for up to three ancestors, so it can be found in the code.
function describe(el) {
  const part = (node) =>
    node.tagName.toLowerCase() +
    (node.id ? `#${node.id}` : '') +
    [...node.classList].slice(0, 4).map((c) => `.${c}`).join('')
  const path = []
  let node = el
  while (node && node !== document.body && path.length < 4) {
    path.unshift(part(node))
    node = node.parentElement
  }
  return path.join(' > ')
}

function details(el) {
  const s = getComputedStyle(el)
  const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim()
  return {
    selector: describe(el),
    text: (own || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    style: {
      font: `${s.fontWeight} ${s.fontSize}/${s.lineHeight} ${s.fontFamily}`,
      color: s.color,
      background: s.backgroundColor,
      margin: s.margin,
      padding: s.padding,
      opacity: s.opacity
    }
  }
}

// The elements under the slice: the topmost one at each point of a grid
// across it, without repeats.
function nodesIn(rect) {
  const found = []
  const steps = 6
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const x = rect.x + (rect.width * i) / steps
      const y = rect.y + (rect.height * j) / steps
      const el = document.elementFromPoint(Math.min(x, window.innerWidth - 1), Math.min(y, window.innerHeight - 1))
      if (el && !el.closest('[data-taglio]') && !found.includes(el)) found.push(el)
    }
  }
  return found
}

// The smallest element that covers the whole slice, found by starting at the
// element under the slice's center and climbing until it covers it, so the
// screenshot renders that rather than the whole page.
function container(rect) {
  const covers = (el) => {
    const r = el.getBoundingClientRect()
    return r.left <= rect.x + 1 && r.top <= rect.y + 1 && r.right >= rect.x + rect.width - 1 && r.bottom >= rect.y + rect.height - 1
  }
  let node = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) || document.body
  while (node && node !== document.documentElement && !covers(node)) node = node.parentElement
  return node || document.documentElement
}

// Marks each element under `host` that lies wholly outside the slice (with
// a little room around it), without marking inside one already marked, and
// records its size. Returns the marked elements, to unmark afterwards.
const SKIP = 'data-taglio-skip'
function markOutside(host, rect) {
  const pad = 24
  const marked = []
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_ELEMENT)
  let node = walker.nextNode()
  while (node) {
    const r = node.getBoundingClientRect()
    const outside = r.right < rect.x - pad || r.left > rect.x + rect.width + pad || r.bottom < rect.y - pad || r.top > rect.y + rect.height + pad
    if (outside && (r.width || r.height) && !('taglio' in node.dataset)) {
      const inline = getComputedStyle(node).display === 'inline' ? 1 : 0
      node.setAttribute(SKIP, `${r.width},${r.height},${inline}`)
      marked.push(node)
      // Skip its children: they go with it.
      let next = walker.nextSibling()
      while (!next && walker.parentNode()) {
        if (walker.currentNode === host) break
        next = walker.nextSibling()
      }
      node = next
      continue
    }
    node = walker.nextNode()
  }
  return marked
}

// Renders the element that holds the slice and crops it to the slice. Each
// step is logged with its time into `log`, which goes with the note, so a
// slow or failed capture shows where it stalled. Any image, video or font it
// loads gets 4 seconds, so one stuck asset is skipped rather than holding up
// the rest.
async function capture(rect, log) {
  const t0 = performance.now()
  const mark = (step) => log.push(`${Math.round(performance.now() - t0)}ms ${step}`)
  const scale = Math.min(2, window.devicePixelRatio || 1)
  const host = container(rect)
  const box = host.getBoundingClientRect()
  const whole = host === document.documentElement
  mark(`host ${describe(host) || host.tagName.toLowerCase()} ${Math.round(box.width)}x${Math.round(box.height)}`)
  // Only what touches the slice is drawn. Everything else is marked, kept
  // in the copy at its own size but hidden and without its children, so a
  // tall host costs little more than the slice itself and nothing in the
  // slice moves. (Leaving those elements out of the copy entirely would let
  // what's below them move up into the slice.)
  const skipped = markOutside(host, rect)
  mark(`skipped ${skipped.length} elements outside the slice`)
  let lastProgress = 0
  let shot
  try {
    shot = await domToPng(host, {
      scale,
      timeout: 4000,
      progress: (current, total) => {
        if (current === total || current - lastProgress >= 5) {
          lastProgress = current
          mark(`assets ${current}/${total}`)
        }
      },
      ...(whole && {
        width: window.innerWidth,
        height: window.innerHeight,
        style: { transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)` }
      }),
      filter: (node) => {
        if (node.dataset && 'taglio' in node.dataset) return false
        return !(node.parentElement && node.parentElement.hasAttribute(SKIP))
      },
      onCloneEachNode: (clone) => {
        if (clone.nodeType !== 1 || !clone.hasAttribute(SKIP)) return
        const [width, height, inline] = clone.getAttribute(SKIP).split(',')
        clone.style.setProperty('visibility', 'hidden', 'important')
        clone.style.setProperty('width', `${width}px`, 'important')
        clone.style.setProperty('height', `${height}px`, 'important')
        clone.style.setProperty('box-sizing', 'border-box', 'important')
        if (inline === '1') clone.style.setProperty('display', 'inline-block', 'important')
        clone.removeAttribute(SKIP)
      }
    })
  } finally {
    for (const el of skipped) el.removeAttribute(SKIP)
  }
  mark('rendered')
  const image = new Image()
  image.src = shot
  await image.decode()
  const left = whole ? rect.x : rect.x - box.left
  const top = whole ? rect.y : rect.y - box.top
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(rect.width * scale)
  canvas.height = Math.round(rect.height * scale)
  canvas.getContext('2d').drawImage(image, left * scale, top * scale, rect.width * scale, rect.height * scale, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

// Notes waiting for a terminal, kept whole (picture included) in IndexedDB,
// which holds far more than localStorage and survives a reload.
const outbox = {
  db: null,
  open() {
    this.db = this.db || new Promise((resolve, reject) => {
      const req = indexedDB.open(KEY, 1)
      req.onupgradeneeded = () => req.result.createObjectStore('notes', { keyPath: 'key' })
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return this.db
  },
  async run(mode, fn) {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('notes', mode)
      const req = fn(tx.objectStore('notes'))
      tx.oncomplete = () => resolve(req && req.result)
      tx.onerror = () => reject(tx.error)
    })
  },
  put: (note) => outbox.run('readwrite', (s) => s.put(note)),
  all: () => outbox.run('readonly', (s) => s.getAll()),
  remove: (key) => outbox.run('readwrite', (s) => s.delete(key))
}

// The connection to `taglio watch`. The pencil asks /health every few
// seconds while the tab is visible; the answer names the project, so with
// several projects open it's clear which terminal a page talks to.
let connection = { ok: false, project: null }
let button = null
let dot = null

async function check() {
  let next = { ok: false, project: null }
  try {
    const res = await fetch(`${SERVER}/health`, { cache: 'no-store' })
    if (res.ok) next = { ok: true, ...(await res.json()) }
  } catch {}
  const changed = next.ok !== connection.ok
  connection = next
  paintButton()
  if (connection.ok) flush()
  if (changed) render()
}

// Every 3 seconds while connected or while a note waits, so a note goes as
// soon as a terminal connects. Otherwise every 15 seconds, since each failed
// check logs a connection error in the browser's console. Opening the slice
// checks at once.
async function waiting() {
  try {
    return (await outbox.all()).length > 0
  } catch {
    return false
  }
}

function watchConnection() {
  let next = 0
  const loop = async () => {
    if (document.visibilityState === 'visible') await check()
    next = setTimeout(loop, connection.ok || (await waiting()) ? 3000 : 15000)
  }
  loop()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    clearTimeout(next)
    loop()
  })
}

function paintButton() {
  if (!button) return
  css(dot, { background: connection.ok ? '#30d158' : '#8e8e93' })
  button.title = connection.ok
    ? `taglio, connected to ${connection.project} (Alt+Shift+S)`
    : 'taglio, not connected. Run /taglio in Claude Code, or npx taglio watch (Alt+Shift+S)'
  button.setAttribute('aria-label', button.title)
}

let flushing = false
async function flush() {
  if (flushing) return
  flushing = true
  try {
    const waiting = (await outbox.all()).sort((a, b) => a.key.localeCompare(b.key))
    for (const note of waiting) {
      if (!(await deliver(note))) break
      await outbox.remove(note.key)
    }
  } catch {}
  flushing = false
}

// Sends one note. True when the server took it, false when it couldn't be
// reached (the note keeps waiting). A note the server refuses is marked
// failed, with the server's reason.
async function deliver({ key, payload }) {
  let response
  try {
    response = await fetch(`${SERVER}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
  } catch {
    connection = { ok: false, project: null }
    paintButton()
    update(key, { state: 'waiting' })
    return false
  }
  const result = await response.json().catch(() => null)
  if (response.ok && result && result.ok) update(key, { id: result.id, state: 'queued' })
  else update(key, { state: 'failed', message: (result && result.error) || 'Could not send', doneAt: Date.now() })
  return true
}

// The tray beside the pencil: one pill per note, showing where it is.
// Sending, Waiting and Sent come from the page; Claude marks a note
// Processing and then Done (`taglio status`), which the page picks up by
// asking the server every two seconds while any note is open. The list is
// kept in localStorage, so it survives the reloads a code change brings. A
// done note stays 30 seconds, then goes.
const LABEL = { sending: 'Sending…', waiting: 'Waiting', queued: 'Sent', processing: 'Processing', done: 'Done', failed: 'Failed' }
const DOT = { sending: '#8e8e93', waiting: '#8e8e93', queued: BLUE, processing: '#ffd60a', done: '#30d158', failed: '#ff453a' }
const KEEP = 30000

const load = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || []
  } catch {
    return []
  }
}
const save = (list) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {}
}

let tray = null
let timer = 0

function pill(parent) {
  return make('div', {
    display: 'flex', alignItems: 'center', gap: '8px', maxWidth: '340px', padding: '7px 12px 7px 10px',
    borderRadius: '16px', background: 'rgba(28,28,30,.92)', border: '.5px solid rgba(255,255,255,.14)',
    color: '#fff', font: `12px/1.3 ${FONT}`, boxShadow: '0 4px 16px rgba(0,0,0,.35)', pointerEvents: 'auto'
  }, parent)
}

function render() {
  const now = Date.now()
  const list = load().filter((n) => !(n.state === 'done' && n.doneAt && now - n.doneAt > KEEP))
  save(list)
  tray.replaceChildren()
  if (!connection.ok && list.some((n) => n.state === 'waiting')) {
    const hint = pill(tray)
    hint.textContent = 'Notes wait here until a terminal connects. Run /taglio in Claude Code.'
    css(hint, { whiteSpace: 'normal', color: 'rgba(255,255,255,.75)' })
  }
  for (const n of list.slice(-5)) {
    const row = pill(tray)
    row.title = [n.note, n.message].filter(Boolean).join('\n\n')
    const light = make('span', { flex: 'none', width: '8px', height: '8px', borderRadius: '50%', background: DOT[n.state] || BLUE }, row)
    if (n.state === 'sending' || n.state === 'processing') light.animate([{ opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }], { duration: 1200, iterations: Infinity })
    const text = make('span', { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, row)
    const label = make('strong', { fontWeight: '600', marginRight: '6px' }, text)
    label.textContent = LABEL[n.state] || n.state
    text.append((n.state === 'done' || n.state === 'failed') && n.message ? n.message : n.note || '(no note)')
    if (n.state === 'done' || n.state === 'failed') {
      const close = make('button', {
        flex: 'none', marginLeft: '2px', padding: '0 2px', border: '0', background: 'none', color: 'rgba(255,255,255,.5)',
        font: `14px/1 ${FONT}`, cursor: 'pointer'
      }, row)
      close.type = 'button'
      close.textContent = '×'
      close.setAttribute('aria-label', 'Dismiss')
      close.addEventListener('click', () => {
        save(load().filter((m) => m.key !== n.key))
        render()
      })
    }
  }
  poll(list)
}

function poll(list) {
  clearTimeout(timer)
  const open = list.filter((n) => n.id && (n.state === 'queued' || n.state === 'processing'))
  const pending = list.some((n) => n.state === 'done')
  if (!open.length) {
    // Keep ticking while a done note waits to fade.
    if (pending) timer = setTimeout(render, 5000)
    return
  }
  timer = setTimeout(async () => {
    try {
      const res = await fetch(`${SERVER}/status?ids=${open.map((n) => n.id).join(',')}`, { cache: 'no-store' })
      const states = await res.json()
      save(load().map((n) => {
        const s = states[n.id]
        if (!s || s.state === 'queued' || s.state === n.state) return n
        return { ...n, state: s.state, message: s.message || null, doneAt: s.state === 'done' ? Date.now() : n.doneAt }
      }))
    } catch {}
    render()
  }, 2000)
}

function track(entry) {
  save([...load(), entry])
  render()
}

function update(key, patch) {
  save(load().map((n) => (n.key === key ? { ...n, ...patch } : n)))
  render()
}

let active = false

function start() {
  if (active) return
  active = true
  check()
  const shade = make('div', { position: 'fixed', inset: '0', zIndex: Z, cursor: 'crosshair', background: 'rgba(0,0,0,.18)' })
  const box = make('div', { position: 'fixed', zIndex: Z + 1, border: `1.5px solid ${BLUE}`, background: 'rgba(10,132,255,.08)', display: 'none', pointerEvents: 'none', borderRadius: '2px' })
  // Without a terminal the slice still works, and a line at the top says
  // where the note will go.
  let banner = null
  if (!connection.ok) {
    banner = make('div', {
      position: 'fixed', top: '14px', left: '50%', transform: 'translateX(-50%)', zIndex: Z + 2, padding: '8px 14px',
      borderRadius: '16px', background: 'rgba(28,28,30,.92)', color: '#fff', font: `13px/1.35 ${FONT}`,
      pointerEvents: 'none', boxShadow: '0 4px 16px rgba(0,0,0,.35)', maxWidth: 'calc(100vw - 28px)', textAlign: 'center'
    })
    banner.textContent = 'No terminal connected yet. Your note will wait until you run /taglio in Claude Code.'
  }
  let from = null
  let rect = null
  let form = null

  const finish = () => {
    active = false
    shade.remove()
    box.remove()
    banner?.remove()
    form?.remove()
    window.removeEventListener('keydown', onKey, true)
  }
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      finish()
    }
  }
  window.addEventListener('keydown', onKey, true)

  const ask = () => {
    form = make('div', {
      position: 'fixed', zIndex: Z + 2, width: '300px', padding: '10px', borderRadius: '12px',
      background: '#1c1c1e', boxShadow: '0 8px 30px rgba(0,0,0,.5)', border: '.5px solid rgba(255,255,255,.12)'
    })
    const below = rect.y + rect.height + 140 < window.innerHeight
    css(form, {
      left: `${Math.max(8, Math.min(rect.x, window.innerWidth - 316))}px`,
      top: below ? `${rect.y + rect.height + 8}px` : `${Math.max(8, rect.y - 120)}px`
    })
    const area = make('textarea', {
      width: '100%', height: '72px', boxSizing: 'border-box', resize: 'none', border: '0', outline: 'none',
      background: 'transparent', color: '#fff', font: `14px/1.4 ${FONT}`
    }, form)
    area.placeholder = 'What should change? Enter sends, Esc cancels.'
    area.focus()
    const row = make('div', { display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }, form)
    const sendButton = make('button', {
      height: '30px', padding: '0 14px', border: '.5px solid rgba(255,255,255,.14)', borderRadius: '15px',
      background: 'rgba(255,255,255,.1)', color: 'rgba(255,255,255,.85)', font: `500 13px/1 ${FONT}`, cursor: 'pointer'
    }, row)
    sendButton.type = 'button'
    sendButton.textContent = 'Send'
    sendButton.addEventListener('mouseenter', () => css(sendButton, { background: 'rgba(255,255,255,.18)' }))
    sendButton.addEventListener('mouseleave', () => css(sendButton, { background: 'rgba(255,255,255,.1)' }))
    sendButton.addEventListener('click', () => send())
    area.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return
      event.preventDefault()
      send()
    })
    const send = async () => {
      const note = area.value.trim()
      const slice = rect
      finish()
      const key = `${Date.now()}`
      track({ key, id: null, note, state: 'sending' })
      // Wait a moment so the overlay is gone before the page is read. A timer
      // rather than animation frames, which a background tab pauses.
      await new Promise((resolve) => setTimeout(resolve, 60))
      const elements = nodesIn(slice).slice(0, 16).map(details)
      let png = null
      let captureError = null
      const captureLog = []
      // The screenshot gets 20 seconds. If it fails or takes longer, the note
      // still goes, with the elements and the reason, but without the picture.
      try {
        png = await Promise.race([
          capture(slice, captureLog),
          new Promise((resolve, reject) => setTimeout(() => reject(new Error('timed out after 20s')), 20000))
        ])
      } catch (error) {
        captureError = String((error && error.message) || error)
        console.warn('[taglio] screenshot failed', error)
      }
      const payload = {
        note,
        url: window.location.pathname + window.location.search,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight, scrollY: Math.round(window.scrollY) },
        rect: { x: Math.round(slice.x), y: Math.round(slice.y), width: Math.round(slice.width), height: Math.round(slice.height) },
        elements,
        png,
        captureError,
        captureLog
      }
      if (connection.ok && (await deliver({ key, payload }))) return
      try {
        await outbox.put({ key, payload })
        update(key, { state: 'waiting' })
      } catch {
        update(key, { state: 'failed', message: 'Could not keep the note for later', doneAt: Date.now() })
      }
    }
  }

  shade.addEventListener('mousedown', (event) => {
    event.preventDefault()
    from = { x: event.clientX, y: event.clientY }
    css(box, { display: 'block', left: `${from.x}px`, top: `${from.y}px`, width: '0', height: '0' })
  })
  shade.addEventListener('mousemove', (event) => {
    if (!from) return
    const x = Math.min(from.x, event.clientX)
    const y = Math.min(from.y, event.clientY)
    css(box, { left: `${x}px`, top: `${y}px`, width: `${Math.abs(event.clientX - from.x)}px`, height: `${Math.abs(event.clientY - from.y)}px` })
  })
  shade.addEventListener('mouseup', (event) => {
    if (!from) return
    let x = Math.min(from.x, event.clientX)
    let y = Math.min(from.y, event.clientY)
    let width = Math.abs(event.clientX - from.x)
    let height = Math.abs(event.clientY - from.y)
    // A click rather than a drag takes the element under it.
    if (width < 8 && height < 8) {
      shade.style.pointerEvents = 'none'
      const el = document.elementFromPoint(event.clientX, event.clientY)
      shade.style.pointerEvents = ''
      if (el) ({ x, y, width, height } = el.getBoundingClientRect())
      css(box, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` })
    }
    from = null
    rect = { x, y, width, height }
    shade.style.cursor = 'default'
    banner?.remove()
    ask()
  })
}

export function mount({ port = 4519, server } = {}) {
  if (button) return
  SERVER = server || `http://localhost:${port}`
  KEY = `taglio:${new URL(SERVER).port || port}`
  // A 44px magenta circle with a solid pencil, so it reads as a tool rather
  // than part of the page, and a dot on it for the connection.
  button = make('button', {
    position: 'fixed', left: '14px', bottom: '14px', zIndex: Z - 1, width: '44px', height: '44px', padding: '0',
    display: 'grid', placeItems: 'center', borderRadius: '50%', border: '0', background: MAGENTA,
    color: '#fff', cursor: 'pointer', boxShadow: '0 10px 40px rgba(0,0,0,.25)'
  })
  button.type = 'button'
  // Material Icons "edit".
  button.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>'
  dot = make('span', {
    position: 'absolute', right: '1px', top: '1px', width: '11px', height: '11px', borderRadius: '50%',
    border: '2px solid #fff', boxSizing: 'border-box', background: '#8e8e93'
  }, button)
  button.addEventListener('click', start)
  tray = make('div', {
    position: 'fixed', left: '68px', bottom: '14px', zIndex: Z - 1, display: 'flex', flexDirection: 'column',
    alignItems: 'flex-start', gap: '6px', pointerEvents: 'none'
  })
  // A note left Sending by a reload mid-capture never finished; drop it.
  save(load().filter((n) => n.state !== 'sending'))
  paintButton()
  render()
  watchConnection()
  window.addEventListener('keydown', (event) => {
    if (event.altKey && event.shiftKey && event.code === 'KeyS') {
      event.preventDefault()
      start()
    }
  })
}
