# @elsetech/xproc

Procfile-based multi-process runner with a live web UI for logs.

Run all your dev processes with one command, and watch their logs in a browser —
per-process pages, real-time streaming, and search.

## Install

```sh
npm install -g @elsetech/xproc
# or per-project:
npm install -D @elsetech/xproc
```

## Usage

Create a `Procfile` in your project root:

```procfile
web: pnpm dev
api: node server.js
worker: node worker.js
```

Then:

```sh
xproc run
```

This starts every process in the Procfile and opens `http://localhost:12345`:

- The left sidebar lists all processes with a live status dot, pid, and command.
- Click a process to open its detail page: full logs since start, streaming in
  real time (auto-scroll sticks to the bottom; scroll up to pause following).
- Press `/` to search the current process's logs, and filter by stream with the
  `all / out / err / sys` chips. Press `Esc` to clear the search.
- The header shows live PID / CPU / MEM for the selected process, plus
  `restart` and `stop`/`start` buttons.

When `xproc run` exits (Ctrl-C, SIGTERM, terminal closed), every process it
started — including grandchildren — is terminated: SIGTERM first, SIGKILL
after 3 seconds.

## Options

```
xproc run [options]

  -f, --procfile <path>   Procfile path (default: ./Procfile)
  -p, --port <port>       Web UI port (default: 12345)
      --no-open           Do not open the browser automatically
```

## Notes

- Log buffers are in-memory and capped at 5000 lines per process.
- The web server binds to `127.0.0.1` only.
- Requires Node.js >= 18.

## License

MIT
