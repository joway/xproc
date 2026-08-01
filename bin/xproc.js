#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { parseProcfile } from '../lib/procfile.js'
import { Supervisor } from '../lib/supervisor.js'
import { createServer } from '../lib/server.js'
import { openBrowser } from '../lib/open.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'))

const USAGE = `xproc v${pkg.version} — Procfile-based multi-process runner with a web UI

Usage:
  xproc run [options]

Options:
  -f, --procfile <path>   Procfile path (default: ./Procfile)
  -p, --port <port>       Web UI port (default: 12345)
      --no-open           Do not open the browser automatically
  -h, --help              Show this help
  -v, --version           Show version
`

function parseArgs(argv) {
  const opts = { procfile: 'Procfile', port: 12345, open: true }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-f' || a === '--procfile') opts.procfile = argv[++i]
    else if (a === '-p' || a === '--port') { opts.port = Number(argv[++i]); opts.portExplicit = true }
    else if (a === '--no-open') opts.open = false
    else if (a === '-h' || a === '--help') opts.help = true
    else if (a === '-v' || a === '--version') opts.version = true
    else rest.push(a)
  }
  return { opts, rest }
}

async function main() {
  const { opts, rest } = parseArgs(process.argv.slice(2))
  if (opts.version) return console.log(pkg.version)
  if (opts.help || rest[0] !== 'run') return console.log(USAGE)
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    console.error(`xproc: invalid port: ${opts.port}`)
    process.exit(1)
  }

  const procfilePath = path.resolve(opts.procfile)
  if (!fs.existsSync(procfilePath)) {
    console.error(`xproc: Procfile not found: ${procfilePath}`)
    process.exit(1)
  }

  let entries
  try {
    entries = parseProcfile(fs.readFileSync(procfilePath, 'utf8'))
  } catch (err) {
    console.error(`xproc: ${err.message}`)
    process.exit(1)
  }
  if (entries.length === 0) {
    console.error('xproc: Procfile has no process entries')
    process.exit(1)
  }

  const supervisor = new Supervisor(entries)
  const home = process.env.HOME || ''
  const server = createServer(supervisor, {
    version: pkg.version,
    procfile: home && procfilePath.startsWith(home) ? '~' + procfilePath.slice(home.length) : procfilePath,
    startedAt: Date.now(),
  })

  let retriedRandomPort = false
  server.on('error', err => {
    if (err.code === 'EADDRINUSE' && !opts.portExplicit && !retriedRandomPort) {
      // Default port taken (another xproc?) — fall back to an OS-assigned one.
      retriedRandomPort = true
      console.log(`xproc: port ${opts.port} is in use, picking a random port...`)
      server.listen(0, '127.0.0.1')
      return
    }
    if (err.code === 'EADDRINUSE') {
      console.error(`xproc: port ${opts.port} is already in use`)
    } else {
      console.error(`xproc: server error: ${err.message}`)
    }
    process.exit(1)
  })

  server.on('listening', () => {
    const url = `http://localhost:${server.address().port}`
    console.log(`xproc: web UI at ${url}`)
    supervisor.startAll()
    if (opts.open) openBrowser(url)
  })
  server.listen(opts.port, '127.0.0.1')

  let shuttingDown = false
  const shutdown = async signal => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\nxproc: received ${signal}, stopping processes...`)
    await supervisor.stopAll()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGHUP', () => shutdown('SIGHUP'))
}

main()
