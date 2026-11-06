import { describe, expect, it } from 'vitest'
import { reduce } from '../src/shared/reduce.js'
import type { HHEvent, Snapshot } from '../src/shared/types.js'
import { availableViews, render, rotation, visible } from '../src/tui.js'

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

describe('view rotation', () => {
  it('takes turns every period and says what comes next', () => {
    const t0 = 1_000_000
    expect(rotation(t0, t0, 120)).toEqual({ view: 'grid', next: 'swim', remainingSec: 120 })
    expect(rotation(t0, t0 + 121_000, 120)).toMatchObject({ view: 'swim', next: 'tree' })
    expect(rotation(t0, t0 + 241_000, 120)).toMatchObject({ view: 'tree', next: 'agents', remainingSec: 119 })
    expect(rotation(t0, t0 + 361_000, 120)).toMatchObject({ view: 'agents', next: 'grid' })
    expect(rotation(t0, t0 + 481_000, 120).view).toBe('grid')
  })
  it('skips views with nothing to show, and shows one view when rotation is off', () => {
    expect(rotation(0, 130_000, 120, ['grid', 'tree']).view).toBe('tree')
    expect(availableViews(snap())).toEqual(['grid', 'swim', 'agents'])
    expect(rotation(0, 999_000, 0).view).toBe('grid')
  })
  it('shows each running agent with its skill, step, recode and what it is doing', () => {
    const text = render(snap(), 140, { color: false }, now.getTime(), 'agents').join('\n')
    expect(text).toContain('Agents and skills · 1 running')
    expect(text).toMatch(/feature-build\s+1 · developer L1/)
    expect(text).toMatch(/L1\s+■ developer\s+opus\s+feature-build\s+#42\s+check \(recode 2\)/)
    expect(text).toContain('Running npm test')
    expect(text).toContain('Idle: lead L1')
  })
  it('keeps decisions on top in every view', () => {
    for (const v of ['grid', 'swim', 'tree', 'agents'] as const) {
      expect(render(snap(), 100, { color: false }, now.getTime(), v).join('\n')).toContain('Needs your decision (1)')
    }
  })
})
