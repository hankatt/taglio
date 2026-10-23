// taglio in the page. Call mount() from your app's entry in development:
//
//   if (import.meta.env.DEV) import('@taglio/cli').then(({ mount }) => mount({ port: 4519 }))
//
// `npx @taglio/cli init` writes this for you. mount() does nothing outside a
// browser, so a server render can import this module safely, and the overlay
// itself only loads once it's called.

export function mount(options = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (window.__taglio) return
  window.__taglio = true
  const start = () => import('./overlay.js').then(({ mount }) => mount(options))
  if (document.body) start()
  else document.addEventListener('DOMContentLoaded', start, { once: true })
}
