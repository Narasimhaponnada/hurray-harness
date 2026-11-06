import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const RUN_LANES = { command: 'lanes', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

// A hub snapshot like the one /api/state returns, trimmed to what the plugin reads.
const STATE = {
  live: {
    runs: [{ run: 'r1', repo: 'me/app', milestone: '0.2', stage: 'Build', status: 'running', startedAt: 't' }],
    rows: [
      {
        key: 'r1:42', ticket: 42, lane: 'L1', title: 'Cursor pagination', kind: 'dev', current: 'code', finished: false,
        steps: {
          plan: { step: 'plan', status: 'done', agent: { role: 'lead' }, files: [], attempt: 1 },
          code: { step: 'code', status: 'running', agent: { role: 'developer', model: 'sonnet' }, skill: 'feature-build', detail: 'Edit src/api/list.ts', files: [], attempt: 2 },
        },
      },
    ],
    decisions: [{ id: 'd1', title: '#63 Choose tenancy model', why: 'Decision ticket', openedAt: 't', source: 'demo' }],
  },
  trackers: [{ repo: 'me/app', milestone: { title: '0.2' }, board: { Done: 4, Ready: 15 }, changes: [{ number: 88, head: 'feat/42-x', state: 'open', checks: 'success', mergeable: 'mergeable' }] }],
  git: [{ worktrees: [{ branch: 'feat/42-x', ticket: 42, ahead: 3, behind: 1 }] }],
}

const PANE = {
  plugin: 'hurray-harness', component: 'Pane', requestId: 'hh-lanes',
  props: { title: 'Agent lanes', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

function engine(on: On, hub: 'up' | 'down', seen: { status: (string | undefined)[]; toasts: string[] }) {
  mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'lanes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('ui.status', (_, e) => { seen.status.push(e.text); return { value: undefined } })
  on('ui.toast', (_, e) => { seen.toasts.push(e.text); return { value: undefined } })
  on('http.fetch', (_, e) => {
    expect(e.url).toBe('http://127.0.0.1:7311/api/state')
    if (hub === 'down') throw new Error('connection refused')
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(STATE) } }
  })
}

test('the status line and toast show lanes and what needs you', async ($, on) => {
  const seen = { status: [] as (string | undefined)[], toasts: [] as string[] }
  engine(on, 'up', seen)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(RUN_LANES)
  expect(seen.status.at(-1)).toBe('lanes · Build · 1 busy · 1 need you · 4/19 done')
  expect(seen.toasts[0]).toBe('Needs you: #63 Choose tenancy model')
})

test('the pane draws each lane, its agent and what it is doing, on every surface', async ($, on) => {
  engine(on, 'up', { status: [], toasts: [] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN_LANES)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /recode 2/ }))?.text).toContain('code (recode 2)')
    expect((await ui.find({ type: 'Text', text: /developer · sonnet · feature-build/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /Edit src\/api\/list\.ts/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /feat\/42-x \+3 −1 · PR #88 success/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /Needs you \(1\)/ }))).toBeTruthy()
    await ui.unmount()
  }
})

test('a hub that is not running says how to start it', async ($, on) => {
  const seen = { status: [] as (string | undefined)[], toasts: [] as string[] }
  engine(on, 'down', seen)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(RUN_LANES)
  expect(seen.status.at(-1)).toBe('lanes · hub offline (run hh start)')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /hh start/ }))).toBeTruthy()
  await ui.unmount()
})
