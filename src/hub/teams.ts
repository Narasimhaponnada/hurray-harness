import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Decision } from '../shared/types.js'
import type { EventStore } from './store.js'

// Microsoft Teams alerts for decisions. The hub posts an Adaptive Card to a Teams Workflows webhook
// ("When a Teams webhook request is received"). Cards posted that way cannot send a button press back
// (Action.Submit needs a bot), so each option is a link: a signed, expiring URL on the decision
// receiver. Tapping it opens a confirm page, and confirming records the choice. Full guide: docs/TEAMS.md.

export interface TeamsConfig {
  webhookUrl?: string // the Workflows webhook URL; keep it out of git (hh.config.json is ignored)
  publicUrl?: string // where the receiver is reachable from your phone, for example a tunnel URL
  receiverPort: number // the receiver listens on 127.0.0.1 at this port; a tunnel exposes only it
  notify: 'all' | 'harness' // all: label and approval decisions too; harness: only decisions sent as events
  linkHours: number // how long an answer link stays valid
  tunnel: boolean // start a Cloudflare quick tunnel for the receiver
}

export const DEFAULT_TEAMS: TeamsConfig = { receiverPort: 7312, notify: 'all', linkHours: 24, tunnel: false }

// ---------- signed answer links ----------

export interface LinkClaim {
  d: string // decision id
  c: number // option index
  e: number // expiry, seconds since epoch
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url')

export function signLink(secret: Buffer, claim: LinkClaim): string {
  const body = b64(JSON.stringify(claim))
  return body + '.' + b64(createHmac('sha256', secret).update(body).digest())
}

export function verifyLink(secret: Buffer, token: string, nowSec = Math.floor(Date.now() / 1000)): LinkClaim | 'invalid' | 'expired' {
  const [body, mac] = token.split('.')
  if (!body || !mac || token.length > 1200) return 'invalid'
  const want = createHmac('sha256', secret).update(body).digest()
  const got = Buffer.from(mac, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return 'invalid'
  let claim: LinkClaim
  try {
    claim = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LinkClaim
  } catch {
    return 'invalid'
  }
  if (typeof claim.d !== 'string' || !Number.isInteger(claim.c) || typeof claim.e !== 'number') return 'invalid'
  return claim.e < nowSec ? 'expired' : claim
}

// The signing key lives next to the event log, readable only by you. Deleting it voids every link sent.
export function loadSecret(dataDir: string): Buffer {
  const file = join(dataDir, 'teams.secret')
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex')
  mkdirSync(dataDir, { recursive: true })
  const key = randomBytes(32)
  writeFileSync(file, key.toString('hex'), { mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* not supported on this file system */ }
  return key
}

// ---------- the card ----------

type Card = Record<string, unknown>

const wrap = (content: Card) => ({
  type: 'message',
  attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content }],
})

const text = (t: string, extra: Card = {}) => ({ type: 'TextBlock', text: t, wrap: true, ...extra })

export function decisionCard(d: Decision, links: { option: string; url: string }[], note?: string): Card {
  const facts = [
    d.ticket != null ? { title: 'Ticket', value: '#' + d.ticket } : null,
    d.repo ? { title: 'Repo', value: d.repo } : null,
    d.recommendation ? { title: 'Recommended', value: d.recommendation } : null,
  ].filter(Boolean)
  const actions: Card[] = links.map((l) => ({
    type: 'Action.OpenUrl',
    title: l.option + (d.recommendation && d.recommendation.toLowerCase() === l.option.toLowerCase() ? ' (recommended)' : ''),
    url: l.url,
    ...(d.recommendation && d.recommendation.toLowerCase() === l.option.toLowerCase() ? { style: 'positive' } : {}),
  }))
  if (d.url) actions.push({ type: 'Action.OpenUrl', title: 'Open details', url: d.url })
  return wrap({
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    msteams: { width: 'Full' },
    body: [
      text('Needs your decision', { size: 'Small', weight: 'Bolder', color: 'Warning' }),
      text(d.title, { size: 'Large', weight: 'Bolder' }),
      ...(d.why ? [text(d.why, { isSubtle: true })] : []),
      ...(facts.length ? [{ type: 'FactSet', facts }] : []),
      ...(note ? [text(note, { size: 'Small', isSubtle: true })] : []),
    ],
    actions,
  })
}

export function answeredCard(d: Decision): Card {
  return wrap({
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      text('Decided', { size: 'Small', weight: 'Bolder', color: 'Good' }),
      text(`${d.title}: ${d.answer?.choice ?? ''}`, { weight: 'Bolder' }),
      text(`Answered through ${d.answer?.via ?? 'the hub'}. The harness carries on.`, { size: 'Small', isSubtle: true }),
    ],
  })
}

// ---------- the notifier ----------

type Fetch = (url: string, init: RequestInit) => Promise<Response>

export class TeamsNotifier {
  private busy = Promise.resolve()

  constructor(
    readonly cfg: TeamsConfig,
    private store: EventStore,
    private secret: Buffer,
    private post: Fetch = (url, init) => fetch(url, init),
  ) {}

  get enabled(): boolean {
    return !!this.cfg.webhookUrl
  }

  links(d: Decision, nowSec = Math.floor(Date.now() / 1000)): { option: string; url: string }[] {
    if (!this.cfg.publicUrl || !d.options?.length) return []
    const base = this.cfg.publicUrl.replace(/\/+$/, '')
    const e = nowSec + Math.round(this.cfg.linkHours * 3600)
    return d.options.map((option, c) => ({ option, url: `${base}/d/${signLink(this.secret, { d: d.id, c, e })}` }))
  }

  // Called with every snapshot: sends one card per decision the first time it is seen, and a short
  // "Decided" card when one is answered. Sent ids are kept in the store, so a restart sends nothing twice.
  sync(open: Decision[], answered: Decision[]): Promise<void> {
    if (!this.enabled) return this.busy
    this.busy = this.busy.then(async () => {
      for (const d of open) {
        if (this.cfg.notify === 'harness' && d.tracker) continue
        const key = this.sentKey(d)
        if (this.store.get(key)) continue
        this.store.set(key, Date.now())
        const links = this.links(d)
        const note = d.options?.length && !links.length
          ? `Options: ${d.options.join(' / ')}. Answer on the dashboard or with: hh answer ${d.id} "<option>"`
          : undefined
        await this.send(decisionCard(d, links, note))
      }
      for (const d of answered) {
        const key = 'teams:done:' + d.id + ':' + (d.answer?.at ?? '')
        if (!d.answer || this.store.get(key)) continue
        this.store.set(key, Date.now())
        if (this.store.get(this.sentKey(d))) await this.send(answeredCard(d))
      }
    })
    return this.busy
  }

  // A tracker decision is re-read on every poll with a new time, so it is known by its id alone.
  private sentKey(d: Decision): string {
    return 'teams:sent:' + d.id + (d.tracker ? '' : ':' + d.openedAt)
  }

  async send(card: Card): Promise<{ ok: boolean; status?: number; error?: string }> {
    if (!this.cfg.webhookUrl) return { ok: false, error: 'no Teams webhook set' }
    try {
      const r = await this.post(this.cfg.webhookUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(card), signal: AbortSignal.timeout(10_000),
      })
      if (!r.ok) process.stderr.write(`Teams: the webhook answered ${r.status}\n`)
      return { ok: r.ok, status: r.status }
    } catch (e) {
      process.stderr.write(`Teams: could not reach the webhook (${(e as Error).message})\n`)
      return { ok: false, error: (e as Error).message }
    }
  }
}
