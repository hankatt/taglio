#!/usr/bin/env node
// taglio's command line. Run it from your project's root.
//
//   taglio init                          set taglio up in this project
//   taglio watch [--port N]              connect the page to this terminal
//   taglio status <id> <state> [text]    mark a note processing, done or failed

import path from 'node:path'
import { init, configuredPort, portFor, readPackage, detect } from '../lib/init.js'
import { createServer, setStatus, unhandled, projectName, VERSION } from '../lib/server.js'
import { watchApple, bundleId } from '../lib/apple.js'

const root = process.cwd()
const [command, ...args] = process.argv.slice(2)

const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? null : args[i + 1]
}

function portHere() {
  return Number(flag('port')) || Number(process.env.TAGLIO_PORT) || configuredPort(root) || portFor(readPackage(root)?.name || path.basename(root))
}

function watch() {
  const port = portHere()
  const project = projectName(root)
  // A person at a terminal gets readable lines; Claude Code, reading the
  // output through a pipe, gets one line of JSON per note.
  const human = process.stdout.isTTY && !args.includes('--json')
  const say = (summary) => {
    if (!human) return process.stdout.write(JSON.stringify(summary) + '\n')
    const place = summary.url || summary.screen
    const where = place ? ` on ${summary.platform ? `${summary.platform}, ` : ''}${place}` : ''
    process.stdout.write(`\n● ${summary.note || '(no note)'}${where}\n  ${summary.json}${summary.image ? `\n  ${summary.image}` : ''}\n`)
  }

  // An iOS app's notes come through its container, not the network.
  if (detect(root).kind === 'ios') {
    const bundle = bundleId(root)
    if (!bundle) {
      console.error("taglio: couldn't find the app's bundle ID in the Xcode project. Add it to .taglio/config.json as { \"bundleId\": \"com.example.app\" }.")
      process.exit(1)
    }
    if (human) console.log(`taglio ${VERSION}, watching ${project} (${bundle}) in booted simulators and on iPhones Xcode is connected to. Notes show here. Ctrl+C stops.`)
    else process.stdout.write(JSON.stringify({ watching: project, app: bundle, root }) + '\n')
    for (const summary of unhandled(root)) say(summary)
    const apple = watchApple({ root, bundle, onNote: say })
    const stop = () => {
      apple.stop()
      process.exit(0)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    return
  }

  const server = createServer({ root, port, onNote: say })
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`taglio: port ${port} is taken. Another \`taglio watch\` may already be running for this project, or another program uses the port. Use --port to pick another, and the same port in the app's mount({ port }).`)
      process.exit(1)
    }
    throw error
  })
  server.listen(port, '127.0.0.1', () => {
    if (human) console.log(`taglio ${VERSION}, watching ${project} on http://localhost:${port}. Notes from the page show here. Ctrl+C stops.`)
    else process.stdout.write(JSON.stringify({ watching: project, port, root }) + '\n')
    // Notes saved while nothing was watching, so none is lost.
    for (const summary of unhandled(root)) say(summary)
  })
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

function status() {
  const [id, state, ...rest] = args
  if (!/^[\w-]+$/.test(id || '') || !['processing', 'done', 'failed'].includes(state)) {
    console.error('Usage: taglio status <id> <processing|done|failed> [message]')
    process.exit(1)
  }
  setStatus(root, id, state, rest.join(' '))
  console.log(`${id}: ${state}`)
}

const help = `taglio ${VERSION}: slice part of your running app, add a note, send both to your terminal.

  npx taglio init       set it up in this project (run once)
  npx taglio watch      connect the page to this terminal and print its notes
  npx taglio status <id> <processing|done|failed> [message]

In Claude Code, /taglio starts the watch for you and works through each note.`

if (command === 'init') init(root)
else if (command === 'watch') watch()
else if (command === 'status') status()
else if (command === '--version' || command === '-v') console.log(VERSION)
else {
  console.log(help)
  if (command && command !== 'help' && command !== '--help' && command !== '-h') process.exit(1)
}
