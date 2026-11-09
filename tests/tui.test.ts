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
    expect(text).toMatch(/↳ feature-build · opus · \d+:\d\d · Running npm test/)
    expect(text).toContain('3/10 done')
  })

  it('never draws wider than the terminal', () => {
    for (const w of [80, 100, 160]) {
      for (const line of render(snap(), w, { color: true }, now.getTime())) expect(visible(line), line.replace(/\x1b\[[0-9;]*m/g, '')).toBeLessThanOrEqual(w)
    }
  })

  it('uses no escape codes without color', () => {
    expect(render(snap(), 100, { color: false }, now.getTime()).join('')).not.toMatch(/\x1b/)
  })
})

describe('two views', () => {
  it('Now and Flow take turns every period and say what comes next', () => {
    const t0 = 1_000_000
    expect(rotation(t0, t0, 120)).toEqual({ view: 'now', next: 'flow', remainingSec: 120 })
    expect(rotation(t0, t0 + 121_000, 120)).toMatchObject({ view: 'flow', next: 'now' })
    expect(rotation(t0, t0 + 241_000, 120).view).toBe('now')
    expect(rotation(0, 999_000, 0).view).toBe('now')
  })
  it('skips Flow when there is no step and no worktree yet', () => {
    expect(availableViews(snap())).toEqual(['now', 'flow'])
    expect(availableViews({ ...snap(), live: { ...snap().live, segments: [] } })).toEqual(['now'])
  })
  it('Now shows the skills running, each agent in the grid with model, time and doing now, and idle agents', () => {
    const text = render(snap(), 140, { color: false }, now.getTime(), 'now').join('\n')
    expect(text).toMatch(/Skills running feature-build ×1 \(developer L1\)/)
    expect(text).toContain('recode 2')
    expect(text).toMatch(/↳ feature-build · opus · \d+:\d\d · Running npm test/)
    expect(text).toContain('Idle: lead L1')
    expect(text).not.toContain('Flow ·')
  })
  it('Flow ends each lane with where its branch stands on merging', () => {
    const s = snap()
    s.git = [{ repoPath: '/r', base: 'origin/develop', fetchedAt: 't', worktrees: [{ path: '/w', branch: 'feat/42-x', head: 'a', ticket: 42, ahead: 3, behind: 1, dirty: false }] }]
    s.trackers[0]!.changes = [{ number: 88, title: 't', head: 'feat/42-x', base: 'develop', state: 'open', draft: false, mergeable: 'mergeable', checks: 'success', url: 'u', ticket: 42 }]
    const text = render(s, 140, { color: false }, now.getTime(), 'flow').join('\n')
    expect(text).toContain('Flow · last')
    expect(text).toMatch(/L1 .*▏PR #88 · behind 1/)
    // Under the lane: its local worktree.
    expect(text).toContain('└ feat/42-x · 3 ahead · 1 behind · clean · → merges develop in first')
    expect(text).not.toContain('Product phases')
  })
  it('keeps decisions on top in both views', () => {
    for (const v of ['now', 'flow'] as const) {
      expect(render(snap(), 100, { color: false }, now.getTime(), v).join('\n')).toContain('Needs your decision (1)')
    }
  })
})

describe('Now on GitHub', () => {
  const it2 = (number: number, title: string, status: string, o: Record<string, unknown> = {}) => ({ number, title, type: 'Issue', state: 'open', status, labels: [], url: '', prs: [], ...o })
  const snapWith = () => {
    const live = reduce([])
    return {
      live, git: [], hub: { startedAt: '', events: 0, demo: false },
      trackers: [{
        provider: 'github', repo: 'me/db', fetchedAt: 't', board: {}, epics: [],
        items: [
          it2(1, 'WAL replay drops a segment', 'In progress', { type: 'Bug', assignees: ['ana'], prs: [{ number: 9, state: 'open', url: '' }] }),
          it2(2, 'Package arm64 builds', 'In review'),
          it2(3, 'Handle leak under cgroup v2', 'Todo', { labels: ['bug'] }),
          it2(4, 'Docs', 'Todo'),
        ],
        changes: [{ number: 9, title: '', head: 'fix/1', base: 'main', state: 'open', draft: false, mergeable: 'conflicting', checks: 'failure', url: '', ticket: 1 }],
      }],
    } as never
  }

  it('shows bugs and issues in flight with their PR, without agent lanes and without empty phases', () => {
    const out = render(snapWith(), 110, { color: false }, Date.now(), 'now').join('\n')
    expect(out).toContain('Now on GitHub · 1 in progress · 1 in review · 2 open bugs')
    expect(out).toMatch(/#1 +bug in progress WAL replay drops a segment +PR #9 · ✗ checks · ✗ conflict · @ana/)
    expect(out).toMatch(/#2 +in review +Package arm64 builds/)
    expect(out).toContain('Bugs not started: #3 Handle leak under cgroup v2')
    expect(out).not.toContain('#4')
    expect(out).not.toContain('Product phases')
  })

  it('stays inside a narrow terminal', () => {
    for (const w of [60, 72, 80]) {
      for (const line of render(snapWith(), w, { color: true }, Date.now(), 'now')) expect(visible(line)).toBeLessThanOrEqual(w)
    }
  })
})
