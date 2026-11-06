import { describe, expect, it } from 'vitest'
import { reduce } from '../src/shared/reduce.js'
import type { HHEvent } from '../src/shared/types.js'
import { toEvent } from '../src/shared/validate.js'

let n = 0
const ev = (e: Partial<HHEvent>): HHEvent => ({ v: 1, ts: new Date(Date.UTC(2026, 10, 6, 10, 0, n++)).toISOString(), source: 'my-harness', run: 'r1', repo: 'o/r', kind: 'activity', ...e }) as HHEvent
const now = new Date(Date.UTC(2026, 10, 6, 10, 5))

describe('reduce', () => {
  it('builds a lane row with steps, agents and the running step', () => {
    const s = reduce([
      ev({ kind: 'run.start', stage: 'Build', skill: 'feature-build' }),
      ev({ kind: 'step.start', ticket: 42, lane: 'L1', step: 'code', agent: { role: 'developer', model: 'sonnet' }, skill: 'feature-build', detail: 'building' }),
      ev({ kind: 'activity', ticket: 42, detail: 'Edit src/a.ts', files: ['src/a.ts'] }),
    ], now)
    const row = s.rows[0]!
    expect(row.lane).toBe('L1')
    expect(row.current).toBe('code')
    expect(row.steps.code!.status).toBe('running')
    expect(row.steps.code!.detail).toBe('Edit src/a.ts')
    expect(row.steps.code!.files).toEqual(['src/a.ts'])
    expect(s.agents[0]).toMatchObject({ role: 'developer', status: 'busy', ticket: 42 })
    expect(s.phases.find((p) => p.name === 'Build')!.status).toBe('running')
  })

  it('counts a step that starts again after failing as a recode attempt', () => {
    const s = reduce([
      ev({ kind: 'step.start', ticket: 47, lane: 'L3', step: 'check' }),
      ev({ kind: 'step.end', ticket: 47, lane: 'L3', step: 'check', status: 'failed' }),
      ev({ kind: 'step.start', ticket: 47, lane: 'L3', step: 'check' }),
    ], now)
    expect(s.rows[0]!.steps.check).toMatchObject({ status: 'running', attempt: 2 })
    expect(s.segments.map((g) => g.status)).toEqual(['failed', 'running'])
  })

  it('opens and closes decisions', () => {
    const open = ev({ kind: 'decision.open', decision: { id: 'd1', title: 'Pick tenancy' } })
    expect(reduce([open], now).decisions).toHaveLength(1)
    expect(reduce([open, ev({ kind: 'decision.close', decision: { id: 'd1', title: '' } })], now).decisions).toHaveLength(0)
  })

  it('moves phases forward with the run stage and never backwards', () => {
    const s = reduce([
      ev({ kind: 'run.start', stage: 'Build' }),
      ev({ kind: 'run.stage', stage: 'Promote' }),
      ev({ kind: 'run.stage', stage: 'Lead' }),
    ], now)
    const st = Object.fromEntries(s.phases.map((p) => [p.name, p.status]))
    expect(st.Build).toBe('done')
    expect(st.Promote).toBe('done')
    expect(st.Plan).toBe('running')
  })

  it('puts test steps in their own kind of row', () => {
    const s = reduce([ev({ kind: 'step.start', ticket: 101, lane: 'QA', step: 'run', agent: { role: 'tester' } })], now)
    expect(s.rows[0]!.kind).toBe('qa')
  })
})

describe('toEvent', () => {
  it('drops unknown keys so content cannot be stored by accident', () => {
    const e = toEvent({ kind: 'activity', detail: 'x', prompt: 'secret', fileContents: 'secret' })
    expect(typeof e).toBe('object')
    expect(JSON.stringify(e)).not.toContain('secret')
  })
  it('rejects unknown kinds and accepts a string agent and #ticket', () => {
    expect(toEvent({ kind: 'nope' })).toMatch(/unknown kind/)
    expect(toEvent({ kind: 'step.start', ticket: '#42', agent: 'tester' })).toMatchObject({ ticket: 42, agent: { role: 'tester' } })
  })
  it('requires decision id and title', () => {
    expect(toEvent({ kind: 'decision.open', decision: { id: 'x' } })).toMatch(/decision/)
  })
})
