// Parses the classic Procfile format: one `name: command` per line.
// Blank lines and lines starting with `#` are ignored.
export function parseProcfile(text) {
  const entries = []
  const seen = new Set()
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '' || line.startsWith('#')) continue
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/)
    if (!m) throw new Error(`Procfile line ${i + 1} is not "name: command": ${line}`)
    const [, name, command] = m
    if (seen.has(name)) throw new Error(`Procfile has duplicate process name: ${name}`)
    seen.add(name)
    entries.push({ name, command })
  }
  return entries
}
