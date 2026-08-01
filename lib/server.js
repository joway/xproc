import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, '../public')

const CONTROL_ACTIONS = { start: 'startOne', stop: 'stopOne', restart: 'restartOne' }

export function createServer(supervisor, meta = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (req.method === 'POST') {
      const m = url.pathname.match(/^\/api\/procs\/([^/]+)\/(start|stop|restart)$/)
      if (m) {
        const name = decodeURIComponent(m[1])
        Promise.resolve(supervisor[CONTROL_ACTIONS[m[2]]](name))
          .then(ok => json(ok ? 200 : 409, { ok }))
          .catch(err => json(500, { ok: false, error: err.message }))
        return
      }
      return json(404, { ok: false, error: 'not found' })
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')))
    } else if (url.pathname === '/logo.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' })
      res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'logo.svg')))
    } else if (url.pathname === '/api/state') {
      json(200, supervisor.snapshot().map(({ logs, ...p }) => p))
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    }
  })

  const wss = new WebSocketServer({ server, path: '/ws' })
  // ws re-emits http server errors here; bin/xproc.js handles them on the server.
  wss.on('error', () => {})

  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'init', meta, procs: supervisor.snapshot() }))
  })

  const broadcast = msg => {
    const data = JSON.stringify(msg)
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data)
    }
  }

  supervisor.on('log', ({ proc, entry }) => broadcast({ type: 'log', proc, entry }))
  supervisor.on('status', proc => broadcast({ type: 'status', proc }))
  supervisor.on('stats', stats => broadcast({ type: 'stats', stats }))

  return server
}
