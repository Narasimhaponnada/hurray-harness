import type { Decision, Snapshot } from './shared/types.js'

// One line per change in what waits on a person, for hh decisions --follow. A Claude Code session
// watches this stream (the decision-watcher skill) and asks you in the Claude app on your phone.

export interface FeedItem {
  type: 'open' | 'answered' | 'closed'
  id: string
  title: string
  why?: string
  recommendation?: string
  options?: string[]
  url?: string
  ticket?: number
  repo?: string
  answerable: boolean // true when hh answer can record it; tracker items are answered on GitHub
  choice?: string
  via?: string
}

const keyOf = (d: Decision) => d.id + (d.tracker ? '' : '|' + d.openedAt)

const itemOf = (d: Decision, type: FeedItem['type']): FeedItem => {
  const item: FeedItem = {
    type, id: d.id, title: d.title, why: d.why, recommendation: d.recommendation, options: d.options,
    url: d.url, ticket: d.ticket, repo: d.repo, answerable: !d.tracker, choice: d.answer?.choice, via: d.answer?.via,
  }
  for (const k of Object.keys(item) as (keyof FeedItem)[]) if (item[k] === undefined) delete item[k]
  return item
}

// Compares the open decisions with the ones seen before and returns what changed.
export class DecisionFeed {
  private open = new Map<string, Decision>()
  private reported = new Set<string>()

  next(snap: Snapshot): FeedItem[] {
    const out: FeedItem[] = []
    const now = new Map(snap.live.decisions.map((d) => [keyOf(d), d]))
    for (const [k, d] of now) if (!this.open.has(k)) out.push(itemOf(d, 'open'))
    for (const [k, d] of this.open) {
      if (now.has(k)) continue
      const done = (snap.live.answered ?? []).find((a) => a.id === d.id && a.openedAt === d.openedAt && a.answer)
      if (done) {
        const rk = 'a|' + k
        if (!this.reported.has(rk)) { this.reported.add(rk); out.push(itemOf(done, 'answered')) }
      } else {
        out.push(itemOf(d, 'closed'))
      }
    }
    this.open = now
    return out
  }
}

export function feedLine(i: FeedItem): string {
  if (i.type === 'answered') return `Decided: ${i.title} → ${i.choice} (via ${i.via})`
  if (i.type === 'closed') return `Closed without an answer: ${i.title}`
  const opts = i.options?.length ? ` · options: ${i.options.join(' / ')}` : ''
  const rec = i.recommendation ? ` · recommended: ${i.recommendation}` : ''
  return `Needs your decision [${i.id}]: ${i.title}${i.why ? ' · ' + i.why : ''}${rec}${opts}${i.url ? ' · ' + i.url : ''}`
}
