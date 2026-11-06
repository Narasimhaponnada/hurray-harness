import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import type { Snapshot } from './shared/types.js'
import { VIEW_NAME, availableViews, mmss, render, rotation, type View } from './tui.js'
import { DEFAULT_PORT, loadConfig } from './hub/config.js'
import { run } from './hub/exec.js'
import { gitRemoteRepo, gitSnapshot } from './hub/git.js'
import { GitHubAdapter } from './hub/trackers/github.js'
import { startDemo } from './hub/demo.js'
import { Hub } from './hub/hub.js'
import { createApp } from './hub/server.js'
import { EventStore } from './hub/store.js'
import { createReceiver } from './hub/receiver.js'
import { TeamsNotifier, loadSecret } from './hub/teams.js'
import { startTunnel } from './hub/tunnel.js'

function statusLine(s: Snapshot): string {
  const run = s.live.runs.find((r) => r.status === 'running')
  const busy = s.live.rows.filter((r) => !r.finished && r.current && r.steps[r.current]?.status === 'running').length
  const board = s.trackers[0]?.board ?? {}
  const total = Object.values(board).reduce((a, b) => a + b, 0)
  const parts = ['lanes']
  if (run?.stage) parts.push(run.stage)
  parts.push(busy + ' busy')
  if (s.live.decisions.length) parts.push(s.live.decisions.length + ' need you')
  if (total) parts.push(`${board['Done'] ?? 0}/${total} done`)
  return parts.join(' · ')
}

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
  hh watch [--rotate 120] [--view now|flow|all] [--port ${DEFAULT_PORT}] [--once] [--no-color]
      The dashboard in your terminal, live. Decisions stay on top; below them two views take turns
      every --rotate seconds (HH_ROTATE, or rotateSeconds in hh.config.json; 0 turns it off). Now: phases, skills, the ticket grid with each agent and what it is doing.
      Flow: swimlanes with each lane's merge state. Keys: n now · f flow · b both · r rotate · ↑↓ · q quit.
  hh status [--port ${DEFAULT_PORT}]
      Print one line for a status bar: stage, busy lanes, what needs you, milestone progress.
      For Claude Code's statusLine setting, or tmux and shell prompts.
  hh ask "Title" --option A --option B [--id ID] [--why TEXT] [--recommend A] [--ticket N] [--url URL]
         [--wait] [--timeout 3600] [--default A]
      Open a decision for a person. With --wait it blocks until someone answers (on the dashboard, with
      hh answer, or from Teams on a phone) and prints the choice, so a harness script can branch on it.
      Exit 0 when answered, 3 on timeout (or prints --default and exits 0), 1 when no hub is running.
  hh answer <id> <option>
      Answer an open decision from the terminal.
  hh teams test
      Send a sample card to the Teams webhook set in hh.config.json or HH_TEAMS_WEBHOOK.
      Teams alerts: hh start --teams-webhook URL [--public-url https://...] [--tunnel]. See docs/TEAMS.md.
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

  if (cmd === 'watch') {
    const once = argv.includes('--once') || !process.stdout.isTTY
    const style = { color: !argv.includes('--no-color') && !process.env.NO_COLOR && (process.stdout.isTTY || argv.includes('--color')) }
    const url = `http://127.0.0.1:${port}/api/state`
    const cfg = loadConfig(argv.slice(1))
    const asked = arg(argv, 'view') as View | undefined
    // A view named on the command line is pinned; otherwise the views take turns every rotateSeconds.
    let pinned: View | null = asked && ['all', 'now', 'flow'].includes(asked) ? asked : cfg.rotateSeconds > 0 ? null : 'all'
    let rotateStart = Date.now()
    let scroll = 0
    let lastLines = 0
    const draw = async (): Promise<boolean> => {
      let lines: string[]
      let footer = ''
      let ok = true
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(2000) })
        const snap = (await r.json()) as Snapshot
        let view: View
        if (pinned) {
          view = pinned
          footer = `${VIEW_NAME[view]} · pinned${cfg.rotateSeconds > 0 ? ' · r resume rotation' : ''}`
        } else {
          const rot = rotation(rotateStart, Date.now(), cfg.rotateSeconds, availableViews(snap))
          view = rot.view
          footer = rot.next === rot.view ? `${VIEW_NAME[view]}` : `${VIEW_NAME[view]} · ${VIEW_NAME[rot.next]} in ${mmss(rot.remainingSec)}`
        }
        lines = render(snap, process.stdout.columns || 120, style, Date.now(), once && !asked ? 'all' : view)
      } catch {
        ok = false
        lines = [`hurray-harness: no hub on port ${port}. Start it with: hh start`, '', 'Retrying every 2 s · q quits']
      }
      if (once) { process.stdout.write(lines.join('\n') + '\n'); return ok }
      // Redraw in place on the alternate screen, clearing each line's tail. A view taller than the
      // terminal scrolls with the arrow keys; the last line shows the view, what comes next, and the keys.
      const rows = (process.stdout.rows || 40) - 1
      lastLines = lines.length
      scroll = Math.max(0, Math.min(scroll, lines.length - rows))
      const keys = (style.color ? '\x1b[2m' : '') + `${footer}   n now · f flow · b both · r rotate${lines.length > rows ? ' · ↑↓ scroll' : ''} · q quit` + (style.color ? '\x1b[0m' : '')
      process.stdout.write('\x1b[H' + lines.slice(scroll, scroll + rows).map((l) => l + '\x1b[K').join('\n') + '\x1b[J\x1b[' + (rows + 1) + ';1H' + keys + '\x1b[K')
      return ok
    }
    if (once) return (await draw()) ? 0 : 1
    process.stdout.write('\x1b[?1049h\x1b[?25l')
    const restore = () => process.stdout.write('\x1b[?25h\x1b[?1049l')
    const quit = () => { restore(); process.exit(0) }
    process.on('SIGINT', quit)
    process.on('SIGTERM', quit)
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.on('data', (d) => {
        const k = d.toString()
        if (k === 'q' || k === '\x03') quit()
        const pick: Record<string, View> = { n: 'now', f: 'flow', b: 'all' }
        if (pick[k]) { pinned = pick[k]!; scroll = 0; void draw() }
        if (k === 'r' && cfg.rotateSeconds > 0) { pinned = null; rotateStart = Date.now(); scroll = 0; void draw() }
        if (k === '\x1b[A') { scroll = Math.max(0, scroll - 3); void draw() }
        if (k === '\x1b[B') { scroll = Math.min(Math.max(0, lastLines - 5), scroll + 3); void draw() }
      })
    }
    process.stdout.on('resize', () => void draw())
    await draw()
    setInterval(() => void draw(), 2000)
    return new Promise<number>(() => {})
  }

  if (cmd === 'status') {
    // Always prints one line and exits 0: a status bar must never show an error box.
    if (!process.stdin.isTTY) await readStdin(200) // Claude Code sends session JSON on stdin; not needed
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(800) })
      process.stdout.write(statusLine((await r.json()) as Snapshot) + '\n')
    } catch {
      process.stdout.write('lanes · hub offline (hh start)\n')
    }
    return 0
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

  if (cmd === 'ask') {
    const title = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined
    const options = argv.flatMap((a, i) => (a === '--option' && argv[i + 1] ? [argv[i + 1]!] : []))
    if (!title) { process.stderr.write('hh ask: needs a title, for example hh ask "Pick the database" --option Postgres --option SQLite\n'); return 2 }
    const id = arg(argv, 'id') ?? 'ask-' + Date.now().toString(36)
    const event = {
      v: 1, kind: 'decision.open', source: arg(argv, 'source') ?? 'cli', user: userInfo().username, machine: hostname(), cwd: process.cwd(),
      ticket: arg(argv, 'ticket'), lane: arg(argv, 'lane'), run: arg(argv, 'run'), repo: arg(argv, 'repo'),
      decision: { id, title, why: arg(argv, 'why'), recommendation: arg(argv, 'recommend'), url: arg(argv, 'url'), options },
    }
    try {
      const r = await post(port, '/api/events', JSON.stringify(event), 5000)
      if (!r.ok) { process.stderr.write('hh ask: ' + (await r.text()) + '\n'); return 1 }
    } catch (e) {
      process.stderr.write(`hh ask: no hub on port ${port} (${(e as Error).message})\n`)
      return 1
    }
    if (!argv.includes('--wait')) { process.stdout.write(id + '\n'); return 0 }
    process.stderr.write(`Waiting for a decision on "${title}" (${id})${options.length ? ': ' + options.join(' / ') : ''}\n`)
    const timeout = Number(arg(argv, 'timeout') ?? 0)
    const until = timeout > 0 ? Date.now() + timeout * 1000 : Infinity
    let misses = 0
    while (Date.now() < until) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/decisions/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(3000) })
        const body = (await r.json()) as { status: string; choice?: string }
        misses = 0
        if (body.status === 'answered' && body.choice) { process.stdout.write(body.choice + '\n'); return 0 }
        if (body.status === 'unknown') { process.stderr.write('hh ask: the decision was closed without an answer\n'); return 4 }
      } catch {
        // The hub may restart while we wait; give up only after a minute without it.
        if (++misses > 30) { process.stderr.write('hh ask: lost the hub\n'); return 1 }
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    const fallback = arg(argv, 'default')
    if (fallback) {
      process.stderr.write(`hh ask: no answer in ${timeout} s; going with the default, ${fallback}\n`)
      try { await post(port, `/api/decisions/${encodeURIComponent(id)}/answer`, JSON.stringify({ choice: fallback, via: 'timeout' }), 3000) } catch { /* hub gone */ }
      process.stdout.write(fallback + '\n')
      return 0
    }
    process.stderr.write(`hh ask: no answer in ${timeout} s\n`)
    return 3
  }

  if (cmd === 'answer') {
    const [id, ...rest] = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--port')
    const choice = rest.join(' ')
    if (!id || !choice) { process.stderr.write('hh answer: needs a decision id and an option\n'); return 2 }
    try {
      const r = await post(port, `/api/decisions/${encodeURIComponent(id)}/answer`, JSON.stringify({ choice, via: 'cli' }), 5000)
      const body = (await r.json()) as { choice?: string; error?: string }
      process.stdout.write(r.ok ? `Decided: ${body.choice}\n` : `hh answer: ${body.error}\n`)
      return r.ok ? 0 : 1
    } catch (e) {
      process.stderr.write(`hh answer: no hub on port ${port} (${(e as Error).message})\n`)
      return 1
    }
  }

  if (cmd === 'teams') {
    if (argv[1] !== 'test') { process.stderr.write('Usage: hh teams test\n'); return 2 }
    try {
      const r = await post(port, '/api/teams/test', '{}', 15_000)
      const body = (await r.json()) as { ok?: boolean; status?: number; error?: string; publicUrl?: string | null }
      if (r.ok) process.stdout.write(`Sent. Check the Teams channel or chat.${body.publicUrl ? ' Answer links open ' + body.publicUrl : ' No public URL yet, so cards have no answer buttons.'}\n`)
      else process.stdout.write(`Not sent: ${body.error ?? 'the webhook answered ' + body.status}\n`)
      return r.ok ? 0 : 1
    } catch (e) {
      process.stderr.write(`hh teams: no hub on port ${port} (${(e as Error).message})\n`)
      return 1
    }
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
    let tunnel: { kill(): void } | undefined
    if (cfg.teams.webhookUrl || cfg.teams.tunnel || cfg.teams.publicUrl) {
      const secret = loadSecret(cfg.dataDir)
      serve({ fetch: createReceiver(hub, secret).fetch, port: cfg.teams.receiverPort, hostname: '127.0.0.1' })
      if (cfg.teams.tunnel && !cfg.teams.publicUrl) {
        try {
          const t = await startTunnel(cfg.teams.receiverPort)
          cfg.teams.publicUrl = t.url
          tunnel = t.child
        } catch (e) {
          process.stderr.write(`Teams: no tunnel (${(e as Error).message}). Cards will have no answer buttons.\n`)
        }
      }
      hub.notifier = new TeamsNotifier(cfg.teams, store, secret)
    }
    hub.start()
    const app = createApp(hub)
    serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
      process.stdout.write(`hurray-harness ${pkg.version} · dashboard on http://${cfg.host}:${info.port}\n`)
      if (cfg.demo) process.stdout.write('Demo mode: sample lanes, issues and worktrees, nothing read from GitHub.\n')
      else if (!cfg.repos.length) process.stdout.write('No repo yet: run it inside a repo, or pass --repo PATH.\n')
      else for (const r of cfg.repos) process.stdout.write(`Watching ${r.path}${r.github ? ' (' + r.github + ')' : ''} · base ${r.base}\n`)
      if (hub.notifier?.enabled) {
        process.stdout.write(`Teams alerts on · receiver on 127.0.0.1:${cfg.teams.receiverPort}${cfg.teams.publicUrl ? ' · answer links via ' + cfg.teams.publicUrl : ' · no public URL, so cards carry no answer buttons'}\n`)
        void hub.notifier.sync(hub.snapshot().live.decisions, [])
      }
    })
    const quit = () => { tunnel?.kill(); hub.stop(); store.close(); process.exit(0) }
    process.on('SIGINT', quit)
    process.on('SIGTERM', quit)
    return new Promise<number>(() => {})
  }

  process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`)
  return 2
}

main(process.argv.slice(2)).then((code) => { if (code !== undefined) process.exitCode = code })
