import { spawn, execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'

const MAX_LOG_LINES = 5000
const KILL_GRACE_MS = 3000
const STATS_INTERVAL_MS = 2000
const IS_WINDOWS = process.platform === 'win32'

// Runs the Procfile entries as child processes, keeps a bounded in-memory log
// buffer per process, and emits events consumed by the web server:
//   'log'    -> { proc, entry: { seq, t, stream, line } }   stream: out | err | sys
//   'status' -> { name, command, status, pid, code, signal, cpu, memMB }
//   'stats'  -> { [name]: { cpu, memMB } }
export class Supervisor extends EventEmitter {
  constructor(entries) {
    super()
    this.procs = new Map()
    this.stopping = false
    this.statsTimer = null
    for (const { name, command } of entries) {
      this.procs.set(name, {
        name,
        command,
        child: null,
        status: 'pending', // pending | running | exited | stopped
        code: null,
        signal: null,
        userStopped: false,
        cpu: null,
        memMB: null,
        seq: 0,
        logs: [],
      })
    }
  }

  startAll() {
    for (const p of this.procs.values()) this.#start(p)
    if (!IS_WINDOWS) {
      this.statsTimer = setInterval(() => this.#pollStats(), STATS_INTERVAL_MS)
      this.statsTimer.unref()
    }
  }

  startOne(name) {
    const p = this.procs.get(name)
    if (!p || this.#alive(p)) return false
    p.userStopped = false
    p.code = p.signal = null
    this.#start(p)
    return true
  }

  async stopOne(name) {
    const p = this.procs.get(name)
    if (!p || !this.#alive(p)) return false
    p.userStopped = true
    await this.#stopProc(p)
    return true
  }

  async restartOne(name) {
    const p = this.procs.get(name)
    if (!p) return false
    if (this.#alive(p)) {
      p.userStopped = true
      await this.#stopProc(p)
    }
    this.#log(p, 'sys', '[xproc] restarting...')
    p.userStopped = false
    p.code = p.signal = null
    this.#start(p)
    return true
  }

  async stopAll() {
    this.stopping = true
    if (this.statsTimer) clearInterval(this.statsTimer)
    const alive = [...this.procs.values()].filter(p => this.#alive(p))
    await Promise.all(alive.map(p => this.#stopProc(p)))
  }

  describe(p) {
    return {
      name: p.name,
      command: p.command,
      status: p.status,
      pid: this.#alive(p) ? p.child.pid : null,
      code: p.code,
      signal: p.signal,
      cpu: p.cpu,
      memMB: p.memMB,
    }
  }

  snapshot() {
    return [...this.procs.values()].map(p => ({ ...this.describe(p), logs: p.logs }))
  }

  #alive(p) {
    return !!p.child && p.child.exitCode === null && p.child.signalCode === null
  }

  #start(p) {
    // detached puts the child in its own process group on POSIX, so killing
    // the group also reaches grandchildren spawned via `sh -c`.
    const child = spawn(p.command, {
      shell: true,
      detached: !IS_WINDOWS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    p.child = child
    p.status = 'running'
    console.log(`xproc: started ${p.name} (pid ${child.pid}): ${p.command}`)
    this.emit('status', this.describe(p))

    this.#pipe(p, child.stdout, 'out')
    this.#pipe(p, child.stderr, 'err')

    child.on('error', err => {
      p.status = 'exited'
      this.#log(p, 'sys', `[xproc] failed to start: ${err.message}`)
      this.emit('status', this.describe(p))
    })

    child.on('exit', (code, signal) => {
      if (p.child !== child) return // a restart already replaced this child
      p.code = code
      p.signal = signal
      p.status = this.stopping || p.userStopped ? 'stopped' : 'exited'
      p.cpu = null
      p.memMB = null
      const reason = signal ? `signal ${signal}` : `code ${code}`
      this.#log(p, 'sys', `[xproc] process exited (${reason})`)
      if (!this.stopping) console.log(`xproc: ${p.name} exited (${reason})`)
      this.emit('status', this.describe(p))
    })
  }

  #pipe(p, stream, kind) {
    let pending = ''
    stream.setEncoding('utf8')
    stream.on('data', chunk => {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const line of lines) this.#log(p, kind, line.replace(/\r$/, ''))
    })
    stream.on('end', () => {
      if (pending !== '') this.#log(p, kind, pending)
      pending = ''
    })
  }

  #log(p, stream, line) {
    const entry = { seq: ++p.seq, t: Date.now(), stream, line }
    p.logs.push(entry)
    if (p.logs.length > MAX_LOG_LINES) p.logs.splice(0, p.logs.length - MAX_LOG_LINES)
    this.emit('log', { proc: p.name, entry })
  }

  async #stopProc(p) {
    const exit = new Promise(resolve => p.child.once('exit', resolve))
    this.#kill(p, 'SIGTERM')
    const timeout = new Promise(resolve => setTimeout(resolve, KILL_GRACE_MS).unref())
    await Promise.race([exit, timeout])
    if (this.#alive(p)) {
      this.#kill(p, 'SIGKILL')
      await exit
    }
  }

  #kill(p, signal) {
    if (IS_WINDOWS) {
      // taskkill /T kills the whole tree; there is no SIGTERM on Windows.
      execFile('taskkill', ['/pid', String(p.child.pid), '/T', '/F'], () => {})
      return
    }
    try {
      process.kill(-p.child.pid, signal) // negative pid = whole process group
    } catch {
      try { p.child.kill(signal) } catch {}
    }
  }

  #pollStats() {
    const running = [...this.procs.values()].filter(p => this.#alive(p))
    if (running.length === 0) return
    const byPid = new Map(running.map(p => [p.child.pid, p]))
    execFile('ps', ['-o', 'pid=,%cpu=,rss=', '-p', [...byPid.keys()].join(',')], (err, stdout) => {
      if (err) return
      const stats = {}
      for (const line of stdout.trim().split('\n')) {
        const [pid, cpu, rss] = line.trim().split(/\s+/)
        const p = byPid.get(Number(pid))
        if (!p || !this.#alive(p)) continue
        p.cpu = Number(cpu)
        p.memMB = Math.round(Number(rss) / 1024)
        stats[p.name] = { cpu: p.cpu, memMB: p.memMB }
      }
      if (Object.keys(stats).length > 0) this.emit('stats', stats)
    })
  }
}
