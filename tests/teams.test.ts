import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../src/hub/config.js'
import { Hub } from '../src/hub/hub.js'
import { createReceiver } from '../src/hub/receiver.js'
import { createApp } from '../src/hub/server.js'
import { EventStore } from '../src/hub/store.js'
import { DEFAULT_TEAMS, TeamsNotifier, decisionCard, signLink, verifyLink } from '../src/hub/teams.js'
import type { HHEvent } from '../src/shared/types.js'

const SECRET = Buffer.alloc(32, 7)
const open: HHEvent = {
  v: 1, ts: '2026-11-06T10:00:00.000Z', kind: 'decision.open', source: 'my-harness', ticket: 63, repo: 'me/app',
  decision: { id: 'db', title: 'Pick the database', why: 'Two ADRs disagree', recommendation: 'Postgres', options: ['Postgres', 'SQLite'] },
}

function setup(webhook?: string) {
  const store = new EventStore(':memory:')
  const hub = new Hub({ ...defaultConfig(), demo: true }, store)
  const sent: unknown[] = []
  const notifier = new TeamsNotifier({ ...DEFAULT_TEAMS, webhookUrl: webhook, publicUrl: 'https://hh.example.com/' }, store, SECRET, async (_url, init) => {
    sent.push(JSON.parse(String(init.body)))
    return new Response('', { status: 202 })
  })
  hub.notifier = notifier
  return { hub, store, notifier, sent, app: createApp(hub), receiver: createReceiver(hub, SECRET) }
}

const tokenOf = (url: string) => url.split('/d/')[1]!

describe('signed answer links', () => {
  it('verify only with the same key, and expire', () => {
    const t = signLink(SECRET, { d: 'db', c: 1, e: 2_000 })
    expect(verifyLink(SECRET, t, 1_000)).toEqual({ d: 'db', c: 1, e: 2_000 })
    expect(verifyLink(SECRET, t, 3_000)).toBe('expired')
    expect(verifyLink(Buffer.alloc(32, 8), t, 1_000)).toBe('invalid')
    const [body, mac] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ d: 'db', c: 0, e: 2_000 })).toString('base64url')
    expect(verifyLink(SECRET, forged + '.' + mac, 1_000)).toBe('invalid')
    expect(verifyLink(SECRET, body!, 1_000)).toBe('invalid')
  })
})

describe('the Teams card', () => {
  it('has one button per option, the recommended one marked, and the facts', () => {
    const { hub, notifier } = setup('https://teams.example/hook')
    hub.ingest(open)
    const d = hub.decision('db')!
    const card = decisionCard(d, notifier.links(d)) as { attachments: { contentType: string; content: { body: { text?: string }[]; actions: { title: string; url: string; style?: string }[] } }[] }
    const content = card.attachments[0]!.content
    expect(card.attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive')
    expect(content.body[1]!.text).toBe('Pick the database')
    expect(content.actions.map((a) => a.title)).toEqual(['Postgres (recommended)', 'SQLite'])
    expect(content.actions[0]!.style).toBe('positive')
    expect(content.actions[1]!.url).toMatch(/^https:\/\/hh\.example\.com\/d\/[\w-]+\.[\w-]+$/)
  })

  it('is sent once per decision, and a short Decided card follows the answer', async () => {
    const { hub, notifier, sent } = setup('https://teams.example/hook')
    hub.ingest(open)
    await notifier.sync(hub.snapshot().live.decisions, [])
    await notifier.sync(hub.snapshot().live.decisions, [])
    expect(sent).toHaveLength(1)
    hub.answer('db', 'sqlite', 'teams')
    await notifier.sync(hub.snapshot().live.decisions, hub.snapshot().live.answered)
    await notifier.sync(hub.snapshot().live.decisions, hub.snapshot().live.answered)
    expect(sent).toHaveLength(2)
    expect(JSON.stringify(sent[1])).toContain('Pick the database: SQLite')
  })

  it('without a public URL, lists the options and how to answer instead of buttons', () => {
    const { hub, store } = setup()
    hub.ingest(open)
    const n = new TeamsNotifier({ ...DEFAULT_TEAMS, webhookUrl: 'x' }, store, SECRET)
    expect(n.links(hub.decision('db')!)).toEqual([])
  })
})

describe('the decision receiver', () => {
  it('shows a confirm page on GET and records nothing until POST', async () => {
    const { hub, notifier, receiver } = setup('https://teams.example/hook')
    hub.ingest(open)
    const link = notifier.links(hub.decision('db')!)[1]!
    const page = await receiver.request('/d/' + tokenOf(link.url))
    expect(page.status).toBe(200)
    expect(page.headers.get('cache-control')).toBe('no-store')
    expect(await page.text()).toContain('Confirm: SQLite')
    expect(hub.decision('db')!.answer).toBeUndefined()

    const done = await receiver.request('/d/' + tokenOf(link.url), { method: 'POST' })
    expect(done.status).toBe(200)
    expect(hub.decision('db')!.answer).toMatchObject({ choice: 'SQLite', via: 'teams' })
    expect(hub.snapshot().live.decisions).toHaveLength(0)
  })

  it('lets the first answer win: other links only show what was decided', async () => {
    const { hub, notifier, receiver } = setup('https://teams.example/hook')
    hub.ingest(open)
    const [pg, lite] = notifier.links(hub.decision('db')!)
    await receiver.request('/d/' + tokenOf(pg!.url), { method: 'POST' })
    const again = await receiver.request('/d/' + tokenOf(lite!.url), { method: 'POST' })
    expect(again.status).toBe(409)
    expect(await again.text()).toContain('Already decided')
    expect(hub.decision('db')!.answer!.choice).toBe('Postgres')
  })

  it('refuses forged tokens and serves nothing else', async () => {
    const { hub, receiver } = setup()
    hub.ingest(open)
    const forged = signLink(Buffer.alloc(32, 1), { d: 'db', c: 0, e: 9e9 })
    expect((await receiver.request('/d/' + forged, { method: 'POST' })).status).toBe(404)
    expect((await receiver.request('/api/state')).status).toBe(404)
    expect(hub.decision('db')!.answer).toBeUndefined()
  })
})

describe('answering through the local API', () => {
  it('reports open, then answered with the choice, for hh ask --wait', async () => {
    const { hub, app } = setup()
    hub.ingest(open)
    expect(await (await app.request('/api/decisions/db')).json()).toMatchObject({ status: 'open' })
    const bad = await app.request('/api/decisions/db/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice: 'MySQL' }) })
    expect(bad.status).toBe(409)
    expect(await bad.json()).toMatchObject({ error: 'choose one of: Postgres, SQLite' })
    const ok = await app.request('/api/decisions/db/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice: 'postgres', via: 'cli' }) })
    expect(await ok.json()).toMatchObject({ ok: true, choice: 'Postgres' })
    expect(await (await app.request('/api/decisions/db')).json()).toMatchObject({ status: 'answered', choice: 'Postgres' })
    expect((await app.request('/api/decisions/nope')).status).toBe(404)
  })

  it('refuses answers posted from another site', async () => {
    const { hub, app } = setup()
    hub.ingest(open)
    const r = await app.request('/api/decisions/db/answer', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ choice: 'SQLite' }) })
    expect(r.status).toBe(403)
    expect(hub.decision('db')!.answer).toBeUndefined()
  })
})
