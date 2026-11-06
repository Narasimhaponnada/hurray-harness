import { describe, expect, it } from 'vitest'
import { DecisionFeed, feedLine } from '../src/feed.js'
import { defaultConfig } from '../src/hub/config.js'
import { Hub } from '../src/hub/hub.js'
import { EventStore } from '../src/hub/store.js'

function hub() {
  return new Hub({ ...defaultConfig(), demo: true }, new EventStore(':memory:'))
}

const ask = (id: string, options?: string[]) => ({
  v: 1 as const, ts: new Date().toISOString(), kind: 'decision.open' as const, source: 'cli',
  decision: { id, title: 'Pick ' + id, recommendation: options?.[0], options },
})

describe('hh decisions --follow', () => {
  it('reports each decision once when it opens, then how it ended', () => {
    const h = hub()
    const feed = new DecisionFeed()
    expect(feed.next(h.snapshot())).toEqual([])
    h.ingest(ask('db', ['Postgres', 'SQLite']))
    const opened = feed.next(h.snapshot())
    expect(opened).toEqual([{ type: 'open', id: 'db', title: 'Pick db', recommendation: 'Postgres', options: ['Postgres', 'SQLite'], answerable: true }])
    expect(feed.next(h.snapshot())).toEqual([])

    h.answer('db', 'sqlite', 'dashboard')
    expect(feed.next(h.snapshot())).toMatchObject([{ type: 'answered', id: 'db', choice: 'SQLite', via: 'dashboard' }])
    expect(feed.next(h.snapshot())).toEqual([])

    h.ingest(ask('cache'))
    feed.next(h.snapshot())
    h.ingest({ v: 1, ts: new Date().toISOString(), kind: 'decision.close', source: 'cli', decision: { id: 'cache', title: '' } })
    expect(feed.next(h.snapshot())).toMatchObject([{ type: 'closed', id: 'cache' }])
  })

  it('marks tracker items as answered on GitHub, not with hh answer', () => {
    const h = hub()
    h.setTracker({
      provider: 'github', repo: 'me/app', fetchedAt: 't1', board: {}, epics: [], changes: [],
      items: [{ number: 7, title: 'Pick a license', type: 'Task', state: 'open', status: 'Ready', labels: ['needs-human'], url: 'u', prs: [] }],
    } as never)
    const feed = new DecisionFeed()
    expect(feed.next(h.snapshot())).toMatchObject([{ type: 'open', id: 'me/app#7:decision', answerable: false }])
    // The next poll re-reads the tracker with a new time: still the same decision, not a new one.
    h.setTracker({
      provider: 'github', repo: 'me/app', fetchedAt: 't2', board: {}, epics: [], changes: [],
      items: [{ number: 7, title: 'Pick a license', type: 'Task', state: 'open', status: 'Ready', labels: ['needs-human'], url: 'u', prs: [] }],
    } as never)
    expect(feed.next(h.snapshot())).toEqual([])
  })

  it('prints a readable line for people', () => {
    expect(feedLine({ type: 'open', id: 'db', title: 'Pick the database', recommendation: 'Postgres', options: ['Postgres', 'SQLite'], answerable: true }))
      .toBe('Needs your decision [db]: Pick the database · recommended: Postgres · options: Postgres / SQLite')
  })
})
