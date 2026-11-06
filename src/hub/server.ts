import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { toEvent } from '../shared/validate.js'
import { hookToEvent } from './hooks.js'
import type { Hub } from './hub.js'

const here = dirname(fileURLToPath(import.meta.url))
// Built UI lives in dist/web next to dist/hub; in development it is served by vite instead.
const WEB_DIRS = [join(here, '..', 'web'), join(here, '..', '..', 'dist', 'web')]

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json',
}

export function createApp(hub: Hub): Hono {
  const app = new Hono()

  // Only this machine may post events: the personal hub listens on 127.0.0.1, and a browser page from
  // another site cannot post here because cross-origin requests with JSON bodies are refused.
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin')
    if (c.req.method !== 'GET' && origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      return c.json({ error: 'cross-origin writes are not allowed' }, 403)
    }
    await next()
  })

  app.get('/api/health', (c) => c.json({ ok: true, events: hub.store.count(), demo: hub.cfg.demo }))

  app.get('/api/state', (c) => c.json(hub.snapshot()))

  app.post('/api/events', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body must be JSON' }, 400)
    }
    const list = Array.isArray(body) ? body : [body]
    if (list.length > 500) return c.json({ error: 'at most 500 events per request' }, 413)
    const accepted: number[] = []
    const errors: { index: number; error: string }[] = []
    list.forEach((raw, index) => {
      const e = toEvent(raw)
      if (typeof e === 'string') errors.push({ index, error: e })
      else { hub.ingest(e); accepted.push(index) }
    })
    return c.json({ accepted: accepted.length, errors }, errors.length && !accepted.length ? 400 : 200)
  })

  // Raw hook JSON from Claude Code or Cursor. Always answers 200 quickly so a hook never slows an agent.
  app.post('/api/hook/:source', async (c) => {
    try {
      const e = hookToEvent(await c.req.json(), c.req.param('source'))
      if (e) hub.ingest(e)
    } catch { /* a malformed hook payload is dropped */ }
    return c.json({ ok: true })
  })

  // A harness waiting on a person reads the decision here (hh ask --wait polls it).
  app.get('/api/decisions/:id', (c) => {
    const id = c.req.param('id')
    const d = hub.decision(id) ?? hub.snapshot().live.decisions.find((x) => x.id === id)
    if (!d) return c.json({ status: 'unknown', id }, 404)
    return c.json({ status: d.answer ? 'answered' : 'open', id, choice: d.answer?.choice, decision: d })
  })

  // Answer from this machine: the dashboard's buttons and hh answer.
  app.post('/api/decisions/:id/answer', async (c) => {
    let body: { choice?: unknown; via?: unknown }
    try { body = await c.req.json() } catch { return c.json({ error: 'body must be JSON' }, 400) }
    if (typeof body.choice !== 'string' || !body.choice.trim()) return c.json({ error: 'choice is required' }, 400)
    const via = typeof body.via === 'string' && /^[a-z-]{1,20}$/.test(body.via) ? body.via : 'dashboard'
    const r = hub.answer(c.req.param('id'), body.choice, via)
    return r.ok ? c.json({ ok: true, choice: r.decision.answer?.choice }) : c.json({ error: r.error }, 409)
  })

  // Sends a sample card to the Teams webhook, to check the setup.
  app.post('/api/teams/test', async (c) => {
    const n = hub.notifier
    if (!n?.enabled) return c.json({ error: 'no Teams webhook set: add teams.webhookUrl to hh.config.json or set HH_TEAMS_WEBHOOK' }, 400)
    const { decisionCard } = await import('./teams.js')
    const sample = { id: 'hh-test', title: 'Test from hurray-harness', why: 'If you can read this on your phone, Teams alerts work.', openedAt: new Date().toISOString(), source: 'cli' }
    const r = await n.send(decisionCard(sample, [], n.cfg.publicUrl ? 'Answer links will open ' + n.cfg.publicUrl : 'No public URL yet: cards will have no answer buttons.'))
    return c.json({ ...r, publicUrl: n.cfg.publicUrl ?? null }, r.ok ? 200 : 502)
  })

  app.post('/api/refresh', async (c) => {
    await hub.poll()
    return c.json({ ok: true })
  })

  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      let open = true
      await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(hub.snapshot()) })
      const off = hub.subscribe((s) => {
        if (open) void stream.writeSSE({ event: 'snapshot', data: JSON.stringify(s) })
      })
      stream.onAbort(() => { open = false; off() })
      while (open) {
        await stream.sleep(25_000)
        if (open) await stream.writeSSE({ event: 'ping', data: String(Date.now()) })
      }
    }),
  )

  app.get('*', (c) => {
    const webDir = WEB_DIRS.find((d) => existsSync(join(d, 'index.html')))
    if (!webDir) return c.text('Dashboard not built. Run: npm run build', 503)
    const rel = normalize(decodeURIComponent(c.req.path)).replace(/^([/\\])+/, '')
    let file = join(webDir, rel)
    if (!file.startsWith(webDir) || !existsSync(file) || rel === '') file = join(webDir, 'index.html')
    try {
      const body = readFileSync(file)
      return c.body(body, 200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    } catch {
      return c.body(readFileSync(join(webDir, 'index.html')), 200, { 'content-type': TYPES['.html']! })
    }
  })

  return app
}
