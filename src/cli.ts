import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { DEFAULT_PORT, loadConfig } from './hub/config.js'
import { run } from './hub/exec.js'
import { gitRemoteRepo, gitSnapshot } from './hub/git.js'
import { GitHubAdapter } from './hub/trackers/github.js'
import { startDemo } from './hub/demo.js'
import { Hub } from './hub/hub.js'
import { createApp } from './hub/server.js'
import { EventStore } from './hub/store.js'

const HELP = `hurray-harness · Track every build. Lose fewer hairs.

Usage
  hh start [--repo PATH]... [--github owner/name]... [--milestone 0.2] [--base origin/develop]
           [--port ${DEFAULT_PORT}] [--refresh 60] [--fetch] [--config hh.config.json] [--demo]
      Start the local hub and dashboard. With no --repo, the current folder is used when it is a git repo.
  hh emit '<json>' [--port ${DEFAULT_PORT}]
      Send one event (or a JSON array) to a running hub. Reads stdin when no JSON is given.
  hh check [--repo PATH] [--github owner/name] [--milestone 0.2]
      Check that git, gh and the tracker can be read, and print what the dashboard would show.
  hh step --ticket N --step NAME [--lane L1] [--agent developer] [--skill S] [--run ID] -- <command> [args]
      Run a command as one lane step: reports it started, then done or failed from its exit code.
      The command's output and exit code pass through unchanged. Works with any harness or script.
  hh hook <claude-code|cursor> [--port ${DEFAULT_PORT}]
      Forward a tool hook's JSON from stdin to the hub. Never blocks the agent and always exits 0.

Docs: docs/EVENTS.md (the event contract), docs/INTEGRATIONS.md (Claude Code, Cursor, any harness).
`

const arg = (argv: string[], name: string) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : undefined
}

async function readStdin(timeoutMs = 2000): Promise<string> {
  if (process.stdin.isTTY) return ''
  return new Promise((resolve) => {
    let data = ''
    const t = setTimeout(() => resolve(data), timeoutMs)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => (data += d))
    process.stdin.on('end', () => { clearTimeout(t); resolve(data) })
  })
}

async function post(port: number, path: string, body: string, timeoutMs: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs),
  })
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0]
  const port = Number(arg(argv, 'port') ?? process.env.HH_PORT ?? DEFAULT_PORT)

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP)
    return 0
  }

  if (cmd === 'emit') {
    const text = argv[1] && !argv[1].startsWith('--') ? argv[1] : await readStdin(5000)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      process.stderr.write('hh emit: the event must be JSON\n')
      return 2
    }
    const stamp = (e: Record<string, unknown>) => ({ v: 1, user: userInfo().username, machine: hostname(), ...e })
    const list = Array.isArray(body) ? body.map((e) => stamp(e as Record<string, unknown>)) : stamp(body as Record<string, unknown>)
    try {
      const r = await post(port, '/api/events', JSON.stringify(list), 5000)
      const out = await r.text()
      process.stdout.write(out + '\n')
      return r.ok ? 0 : 1
    } catch (e) {
      process.stderr.write(`hh emit: no hub on port ${port} (${(e as Error).message})\n`)
      return 1
    }
  }

  if (cmd === 'step') {
    const dash = argv.indexOf('--')
    const opts = dash >= 0 ? argv.slice(1, dash) : argv.slice(1)
    const command = dash >= 0 ? argv.slice(dash + 1) : []
    const ticket = arg(opts, 'ticket')
    const step = arg(opts, 'step')
    if (!ticket || !step || !command.length) { process.stderr.write('hh step: needs --ticket, --step and -- <command>\n'); return 2 }
    const base: Record<string, unknown> = {
      v: 1, user: userInfo().username, machine: hostname(), cwd: process.cwd(), source: arg(opts, 'source') ?? 'cli',
      ticket, step, lane: arg(opts, 'lane'), skill: arg(opts, 'skill'), run: arg(opts, 'run'), repo: arg(opts, 'repo'),
      agent: arg(opts, 'agent') ? { role: arg(opts, 'agent'), model: arg(opts, 'model') } : undefined,
    }
    const send = async (e: Record<string, unknown>) => { try { await post(port, '/api/events', JSON.stringify({ ...base, ...e }), 800) } catch { /* hub not running */ } }
    await send({ kind: 'step.start', detail: 'Running ' + command.join(' ').slice(0, 200) })
    const code = await new Promise<number>((resolve) => {
      const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit' })
      child.on('error', (err) => { process.stderr.write(`hh step: ${err.message}\n`); resolve(127) })
      child.on('exit', (c, sig) => resolve(c ?? (sig ? 128 : 1)))
    })
    await send({ kind: 'step.end', status: code === 0 ? 'done' : 'failed', detail: (code === 0 ? 'Passed: ' : 'Failed (exit ' + code + '): ') + command.join(' ').slice(0, 180) })
    return code
  }

  if (cmd === 'hook') {
    // A hook must never slow or break the agent: short timeout, errors swallowed, exit 0.
    const source = argv[1] && !argv[1].startsWith('--') ? argv[1] : 'claude-code'
    const text = await readStdin(1000)
    if (text.trim()) {
      try { await post(port, '/api/hook/' + encodeURIComponent(source), text, 800) } catch { /* hub not running */ }
    }
    if (source === 'cursor') process.stdout.write('{}\n')
    return 0
  }

  if (cmd === 'check') {
    const cfg = loadConfig(argv.slice(1))
    if (!cfg.repos.length) { process.stderr.write('hh check: run it inside a repo or pass --repo PATH\n'); return 2 }
    let bad = 0
    const auth = await run('gh', ['auth', 'status'], { timeoutMs: 10_000 })
    process.stdout.write(auth.code ? '✗ gh is not signed in: run gh auth login\n' : '✓ gh is signed in\n')
    if (auth.code) bad++
    for (const r of cfg.repos) {
      const g = await gitSnapshot(r.path, r.base)
      if (g.error) { bad++; process.stdout.write(`✗ ${r.path}: ${g.error}\n`); continue }
      process.stdout.write(`✓ ${r.path}: ${g.worktrees.length} worktrees against ${r.base}\n`)
      for (const w of g.worktrees) process.stdout.write(`    ${w.branch}${w.ticket ? ' (#' + w.ticket + ')' : ''} · ${w.ahead} ahead · ${w.behind} behind\n`)
      const gh = r.github ?? (await gitRemoteRepo(r.path))
      if (!gh) { process.stdout.write('  no GitHub remote found; pass --github owner/name\n'); continue }
      const s = await new GitHubAdapter(gh, r.milestone, cfg.labels).snapshot()
      if (s.error) { bad++; process.stdout.write(`✗ ${gh}: ${s.error}\n`); continue }
      process.stdout.write(`✓ ${gh}: milestone ${s.milestone?.title ?? '(none open)'} · ${s.items.length} issues · ${s.epics.length} epics · ${s.changes.length} PRs\n`)
      process.stdout.write('    board: ' + (Object.entries(s.board).map(([k, v]) => k + ' ' + v).join(', ') || 'empty') + '\n')
    }
    return bad ? 1 : 0
  }

  if (cmd === 'start') {
    const cfg = loadConfig(argv.slice(1))
    const store = new EventStore(cfg.demo ? ':memory:' : join(cfg.dataDir, 'events.db'))
    const hub = new Hub(cfg, store)
    await hub.init()
    if (cfg.demo) startDemo(hub)
    hub.start()
    const app = createApp(hub)
    serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
      process.stdout.write(`hurray-harness ${pkg.version} · dashboard on http://${cfg.host}:${info.port}\n`)
      if (cfg.demo) process.stdout.write('Demo mode: sample lanes, issues and worktrees, nothing read from GitHub.\n')
      else if (!cfg.repos.length) process.stdout.write('No repo yet: run it inside a repo, or pass --repo PATH.\n')
      else for (const r of cfg.repos) process.stdout.write(`Watching ${r.path}${r.github ? ' (' + r.github + ')' : ''} · base ${r.base}\n`)
    })
    const quit = () => { hub.stop(); store.close(); process.exit(0) }
    process.on('SIGINT', quit)
    process.on('SIGTERM', quit)
    return new Promise<number>(() => {})
  }

  process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`)
  return 2
}

main(process.argv.slice(2)).then((code) => { if (code !== undefined) process.exitCode = code })
