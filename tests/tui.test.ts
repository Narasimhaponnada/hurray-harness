import { describe, expect, it } from 'vitest'
import { reduce } from '../src/shared/reduce.js'
import type { HHEvent, Snapshot } from '../src/shared/types.js'
import { render, visible } from '../src/tui.js'

let n = 0
const ev = (e: Partial<HHEvent>): HHEvent => ({ v: 1, ts: new Date(Date.UTC(2026, 10, 6, 10, 0, n++)).toISOString(), source: 'h', run: 'r', repo: 'me/app', kind: 'activity', ...e }) as HHEvent
const now = new Date(Date.UTC(2026, 10, 6, 10, 5))

function snap(): Snapshot {
  const live = reduce([
    ev({ kind: 'run.start', stage: 'Build', skill: 'feature-build' }),
    ev({ kind: 'step.end', ticket: 42, lane: 'L1', title: 'Cursor pagination', step: 'plan', status: 'done', agent: { role: 'lead' } }),
    ev({ kind: 'step.start', ticket: 42, lane: 'L1', step: 'check', agent: { role: 'developer', model: 'opus' } }),
    ev({ kind: 'step.end', ticket: 42, lane: 'L1', step: 'check', status: 'failed', agent: { role: 'developer' } }),
    ev({ kind: 'step.start', ticket: 42, lane: 'L1', step: 'check', agent: { role: 'developer', model: 'opus' }, skill: 'feature-build', detail: 'Running npm test' }),
    ev({ kind: 'decision.open', decision: { id: 'd', title: '#63 Pick tenancy' } }),
  ], now)
  return { live, trackers: [{ provider: 'github', repo: 'me/app', board: { Done: 3, Ready: 7 }, items: [], epics: [], changes: [], fetchedAt: 't' }], git: [] }
}

describe('terminal view', () => {
  it('draws decisions, phases and the grid with the agent in each cell', () => {
    const text = render(snap(), 120, { color: false }, now.getTime()).join('\n')
    expect(text).toContain('Needs your decision (1)')
    expect(text).toContain('#63 Pick tenancy')
    expect(text).toContain('waits on you') // the running Build phase holds while a decision is open
    expect(text).toContain('recode 2')
    expect(text).toContain('developer')
    expect(text).toContain('↳ feature-build · opus · Running npm test')
    expect(text).toContain('3/10 done')
  })

  it('never draws wider than the terminal', () => {
    for (const w of [80, 100, 160]) {
      for (const line of render(snap(), w, { color: true }, now.getTime())) expect(visible(line)).toBeLessThanOrEqual(w)
    }
  })

  it('uses no escape codes without color', () => {
    expect(render(snap(), 100, { color: false }, now.getTime()).join('')).not.toMatch(/\x1b/)
  })
})
